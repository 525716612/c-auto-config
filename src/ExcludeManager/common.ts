import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";

// ---------- 辅助函数 ----------
export function findRelativeFolder(
	rootPath: string,
	targetName: string,
	maxDepth: number,
): string | null {
	const queue: { relPath: string; depth: number }[] = [
		{ relPath: "", depth: 0 },
	];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const { relPath, depth } = queue.shift()!;
		const fullPath = path.join(rootPath, relPath);
		if (visited.has(fullPath)) {
			continue;
		}
		visited.add(fullPath);
		const baseName = path.basename(relPath === "" ? rootPath : relPath);
		if (baseName === targetName) {
			return relPath;
		}
		if (depth >= maxDepth) {
			continue;
		}
		try {
			const entries = fs.readdirSync(fullPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const subRelPath = relPath
						? path.join(relPath, entry.name)
						: entry.name;
					if (entry.name === targetName) {
						return subRelPath;
					}
					queue.push({ relPath: subRelPath, depth: depth + 1 });
				}
			}
		} catch (err) {
			/* 忽略无法访问的目录 */
		}
	}
	return null;
}

export function getSourceRelativePaths(
	compileDbPath: string,
	rootPath: string,
	outputChannel?: vscode.OutputChannel,
): string[] {
	if (!fs.existsSync(compileDbPath)) {
		return [];
	}
	try {
		const content = fs.readFileSync(compileDbPath, "utf-8");
		const entries: any[] = JSON.parse(content);
		const paths: string[] = [];
		for (const entry of entries) {
			let file = entry.file;
			if (!file) {
				continue;
			}
			let dir = entry.directory;
			if (!dir) {
				dir = rootPath;
			}
			const absoluteDir = path.isAbsolute(dir)
				? dir
				: path.resolve(rootPath, dir);
			const absoluteFile = path.isAbsolute(file)
				? file
				: path.resolve(absoluteDir, file);
			let relative = path.relative(rootPath, absoluteFile).replace(/\\/g, "/");
			paths.push(relative);
			if (outputChannel) {
				outputChannel.appendLine(
					`[调试] 转换: ${file} (dir: ${dir}) -> ${relative}`,
				);
			}
		}
		return paths;
	} catch (err) {
		console.error("解析 compile_commands.json 失败", err);
		return [];
	}
}

// 新增：根据 Cygwin bash 路径推导三个头文件目录（Windows 绝对路径，正斜杠）
export function getCygwinIncludePaths(cygwinBashPath: string): string[] {
	if (!cygwinBashPath) {return [];}
	const normalized = path.normalize(cygwinBashPath);
	// 提取 Cygwin 根目录: e.g., D:\cygwin\bin\bash.exe -> D:\cygwin
	const binDir = path.dirname(normalized);
	const cygwinRoot = path.dirname(binDir);
	if (!fs.existsSync(cygwinRoot)) {return [];}

	const possiblePaths = [
		path.join(cygwinRoot, "opt", "aeon", "include"),
		path.join(cygwinRoot, "usr", "include"),
		path.join(
			cygwinRoot,
			"opt",
			"aeon",
			"lib",
			"gcc",
			"aeon",
			"4.1.2",
			"include",
		),
	];
	return possiblePaths
		.map((p) => p.replace(/\\/g, "/"))
		.filter((p) => fs.existsSync(p));
}

// 更新 .clangd 文件（合并 -I 路径到 CompileFlags.Add）
export async function updateClangdExclude(
	rootPath: string,
	excludePaths: string[],
	outputChannel?: vscode.OutputChannel,
): Promise<void> {
	const clangdPath = path.join(rootPath, ".clangd");
	const config = vscode.workspace.getConfiguration(
		"cAutoConfig",
		vscode.Uri.file(rootPath),
	);
	let templateObj = config.get<any>("clangdTemplate");
	if (!templateObj || typeof templateObj !== "object") {
		templateObj = {};
		if (outputChannel)
			{outputChannel.appendLine(
				"[警告] 未找到有效的 clangdTemplate 配置，使用空对象",
			);}
	}

	// 确保 CompileFlags.Add 是数组（以便后续可能使用）
	if (!templateObj.CompileFlags) {templateObj.CompileFlags = {};}
	if (!templateObj.CompileFlags.Add) {
		templateObj.CompileFlags.Add = [];
	} else if (!Array.isArray(templateObj.CompileFlags.Add)) {
		templateObj.CompileFlags.Add = [templateObj.CompileFlags.Add];
	}

	// 生成基础 YAML（不含排除块）
	let baseYaml = yaml.dump(templateObj, { indent: 2, lineWidth: 120 });
	// 修复 Remove 缩进
	const lines = baseYaml.split("\n");
	const fixedLines = lines.map((line) =>
		/^Remove:/i.test(line) ? "  " + line : line,
	);
	baseYaml = fixedLines.join("\n");

	// 准备要插入的 -I 标志字符串（不包含末尾多余换行）
	const cygwinBashPath = vscode.workspace
		.getConfiguration("cAutoConfig")
		.get<string>("cygwinPath");
	let extraIFlags = "";
	let addedCount = 0;
	if (cygwinBashPath) {
		const includePaths = getCygwinIncludePaths(cygwinBashPath);
		if (includePaths.length > 0 && outputChannel) {
			outputChannel.appendLine(
				`[调试] 检测到 Cygwin 头文件路径: ${includePaths.join(", ")}`,
			);
		}
		// 生成每一行，末尾不添加换行符（使用 join）
		extraIFlags = includePaths
			.map((p) => `  - '-I${p.replace(/\\/g, "/")}'`)
			.join("\n");
		addedCount = includePaths.length;
	}

	// 将 -I 标志插入到 Add: 行之后，避免多余空行
	if (extraIFlags) {
		// 匹配 "Add:" 行（可能有缩进）
		const addLineRegex = /^(\s*Add:\s*)$/m;
		if (addLineRegex.test(baseYaml)) {
			// 替换 "Add:" 为 "Add:\n" + extraIFlags + "\n"
			baseYaml = baseYaml.replace(addLineRegex, `$1\n${extraIFlags}`);
			if (outputChannel)
				{outputChannel.appendLine(
					`[调试] 已插入 ${addedCount} 个 -I 标志到 .clangd`,
				);}
		} else {
			// 如果没有 Add: 行，则创建 CompileFlags 结构
			baseYaml += `\nCompileFlags:\n  Add:\n${extraIFlags}\n`;
			if (outputChannel)
				{outputChannel.appendLine("[调试] 未找到 Add: 行，已创建并插入 -I 标志");}
		}
	} else {
		if (outputChannel)
			{outputChannel.appendLine(
				"[调试] 未配置 cygwinPath 或路径无效，不添加 -I 标志",
			);}
	}

	// 添加排除块
	let excludeBlock = "";
	if (excludePaths.length > 0) {
		const listItems = excludePaths
			.map((p) => `    - ${p.replace(/\\/g, "/")}/.*`)
			.join("\n");
		excludeBlock = `If:\n  PathExclude:\n${listItems}`;
	} else {
		excludeBlock = "# 无排除规则";
	}
	const finalContent = baseYaml.trim() + "\n\n" + excludeBlock;
	fs.writeFileSync(clangdPath, finalContent, "utf-8");
	if (outputChannel) {
		outputChannel.appendLine(`已生成 ${clangdPath}`);
	}
}
// 更新 settings.json 中的 C_Cpp.files.exclude、search.exclude 以及 C_Cpp.default.systemIncludePath
export async function updateSettingsExclude(
	rootPath: string,
	excludePaths: string[],
	outputChannel?: vscode.OutputChannel,
): Promise<void> {
	const vscodeDir = path.join(rootPath, ".vscode");
	const settingsPath = path.join(vscodeDir, "settings.json");
	if (!fs.existsSync(vscodeDir)) {
		fs.mkdirSync(vscodeDir);
	}
	let settings: any = {};
	if (fs.existsSync(settingsPath)) {
		try {
			const content = fs.readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(content);
		} catch (err) {
			/* 忽略 */
		}
	}

	// 1. C_Cpp.files.exclude（glob 模式）
	if (!settings["C_Cpp.files.exclude"]) {settings["C_Cpp.files.exclude"] = {};}
	const cppFilesExclude = settings["C_Cpp.files.exclude"];
	for (const key of Object.keys(cppFilesExclude)) {
		if (excludePaths.some((p) => key === `${p.replace(/\\/g, "/")}/**`)) {
			delete cppFilesExclude[key];
		}
	}
	for (const p of excludePaths) {
		const normalized = p.replace(/\\/g, "/");
		cppFilesExclude[`${normalized}/**`] = true;
	}
	settings["C_Cpp.files.exclude"] = cppFilesExclude;

	// 2. search.exclude
	if (!settings["search.exclude"]) {settings["search.exclude"] = {};}
	const searchExclude = settings["search.exclude"];
	for (const key of Object.keys(searchExclude)) {
		if (excludePaths.some((p) => key === `${p.replace(/\\/g, "/")}/**`)) {
			delete searchExclude[key];
		}
	}
	for (const p of excludePaths) {
		const normalized = p.replace(/\\/g, "/");
		searchExclude[`${normalized}/**`] = true;
	}
	settings["search.exclude"] = searchExclude;

	// 3. C_Cpp.default.systemIncludePath（系统包含路径）
	if (!settings["C_Cpp.default.systemIncludePath"])
		{settings["C_Cpp.default.systemIncludePath"] = [];}
	const currentSystemInclude = settings["C_Cpp.default.systemIncludePath"];
	// 获取 Cygwin 头文件路径
	const cygwinBashPath = vscode.workspace
		.getConfiguration("cAutoConfig")
		.get<string>("cygwinPath");
	let includePaths: string[] = [];
	if (cygwinBashPath) {
		includePaths = getCygwinIncludePaths(cygwinBashPath);
		if (includePaths.length > 0 && outputChannel) {
			outputChannel.appendLine(
				`[调试] 设置 C_Cpp.default.systemIncludePath: ${includePaths.join(", ")}`,
			);
		}
	}
	// 去重合并：保留用户原有的，追加我们新增的（不删除用户添加的其他路径）
	const newSystemInclude = [...currentSystemInclude];
	for (const incPath of includePaths) {
		if (!newSystemInclude.includes(incPath)) {
			newSystemInclude.push(incPath);
		}
	}
	settings["C_Cpp.default.systemIncludePath"] = newSystemInclude;

	// 写回 settings.json
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), "utf-8");
	if (outputChannel) {
		outputChannel.appendLine(`已更新 ${settingsPath}`);
		outputChannel.appendLine(
			`  C_Cpp.files.exclude: 添加了 ${excludePaths.length} 条 glob 规则`,
		);
		outputChannel.appendLine(
			`  search.exclude: 添加了 ${excludePaths.length} 条 glob 规则`,
		);
		outputChannel.appendLine(
			`  C_Cpp.default.systemIncludePath: 添加了 ${includePaths.length} 个路径`,
		);
	}
}
