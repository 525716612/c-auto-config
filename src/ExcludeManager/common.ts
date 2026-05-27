import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";
import { spawn } from "child_process";

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

// 根据 Cygwin 根目录推导三个头文件目录（Windows 绝对路径，正斜杠）
export function getCygwinIncludePaths(cygwinRoot: string): string[] {
	if (!cygwinRoot) {return [];}
	const normalized = path.normalize(cygwinRoot);
	if (!fs.existsSync(normalized)) {return [];}

	const possiblePaths = [
		path.join(normalized, "opt", "aeon", "include"),
		path.join(normalized, "usr", "include"),
		path.join(
			normalized,
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

/** 从 cygwinRoot 获取 bash.exe 的完整路径 */
export function getBashPath(cygwinRoot: string): string {
	if (!cygwinRoot) {return "";}
	return path.join(cygwinRoot, "bin", "bash.exe");
}

/** 获取编译器路径：优先使用 compilerPath 配置，否则从 cygwinRoot 自动拼接 */
export function getCompilerPath(cygwinRoot: string): string {
	if (!cygwinRoot) {return "";}
	const configPath = vscode.workspace.getConfiguration("cAutoConfig").get<string>("compilerPath");
	if (configPath) {return configPath;}
	return path.join(cygwinRoot, "opt", "aeon", "bin", "aeon-gcc.exe");
}

/** 运行编译器获取内置宏定义，返回宏名字数组（格式同 compile_commands.json 中的 -D 值） */
export async function getCompilerBuiltinDefines(
	cygwinRoot: string,
	outputChannel?: vscode.OutputChannel,
): Promise<string[]> {
	const bashPath = getBashPath(cygwinRoot);
	const compilerPath = getCompilerPath(cygwinRoot);
	if (!fs.existsSync(bashPath) || !fs.existsSync(compilerPath)) {
		if (outputChannel) {
			outputChannel.appendLine(
				`[警告] 编译器或 bash 不存在: ${compilerPath}`,
			);
		}
		return [];
	}

	return new Promise<string[]>((resolve) => {
		const cmd = `"${compilerPath.replace(/\\/g, "/")}" -march=aeonR2 -mhard-div -mhard-mul -mredzone-size=4 -O2 -std=c99 -Wp,-v -E -dM -x c /dev/null`;
		if (outputChannel) {
			outputChannel.appendLine(`[调试] 执行编译器获取内置宏: ${cmd}`);
		}
		const child = spawn(bashPath, ["-l", "-c", cmd], {
			windowsHide: true,
		});

		let stdout = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code !== 0) {
				if (outputChannel) {
					outputChannel.appendLine(
						`[警告] 编译器进程退出码 ${code}, stderr: ${stderr.trim()}`,
					);
				}
				resolve([]);
				return;
			}
			// 解析 #define MACRO 或 #define MACRO value
			const defines: string[] = [];
			const lines = stdout.split("\n");
			for (const line of lines) {
				const match = line.match(/^#define\s+([A-Za-z_][A-Za-z0-9_]*(?:\s+.*)?)$/);
				if (match) {
					let define = match[1].trim();
					// 将 "MACRO value" 转为 "MACRO=value"（VS Code 格式）
					const firstSpace = define.indexOf(" ");
					if (firstSpace > 0) {
						const name = define.substring(0, firstSpace);
						const value = define.substring(firstSpace + 1).trim();
						define = `${name}=${value}`;
					}
					defines.push(define);
				}
			}
			if (outputChannel) {
				outputChannel.appendLine(
					`[调试] 编译器内置宏: 共提取 ${defines.length} 个`,
				);
			}
			resolve(defines);
		});

		child.on("error", (err) => {
			if (outputChannel) {
				outputChannel.appendLine(
					`[警告] 启动编译器失败: ${err.message}`,
				);
			}
			resolve([]);
		});
	});
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
	const cygwinRoot = vscode.workspace
		.getConfiguration("cAutoConfig")
		.get<string>("cygwinRoot");
	let extraIFlags = "";
	let addedCount = 0;
	if (cygwinRoot) {
		const includePaths = getCygwinIncludePaths(cygwinRoot);
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
				"[调试] 未配置 cygwinRoot 或路径无效，不添加 -I 标志",
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
    projectType: string,  // 新增参数
    outputChannel?: vscode.OutputChannel
): Promise<void> {
    const vscodeDir = path.join(rootPath, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');
    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir);
    }
    let settings: any = {};
    if (fs.existsSync(settingsPath)) {
        try {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            settings = JSON.parse(content);
        } catch (err) { /* 忽略 */ }
    }

    // 1. 根据工程类型确定需要清理的基础路径前缀（插件可能管理过的排除规则）
    const managedBasePaths: string[] = [];

    if (projectType === 'MST9U7') {
        const commonRel = findRelativeFolder(rootPath, 'COMMON', 2);
        if (commonRel) {
            const osdRel = path.join(commonRel, 'OSD').replace(/\\/g, '/');
            managedBasePaths.push(osdRel + '/');    // 例如 "COMMON/OSD/"
        }
        const customRel = findRelativeFolder(rootPath, 'CUSTOM', 3);
        if (customRel) {
            const mediatekBase = path.join(customRel, 'Mediatek').replace(/\\/g, '/');
            managedBasePaths.push(mediatekBase + '/'); // "CUSTOM/Mediatek/"
        }
    } else if (projectType === 'MST9U6') {
        const monitorApRel = findRelativeFolder(rootPath, 'monitor_ap', 3);
        if (monitorApRel) {
            const customRel = path.join(monitorApRel, 'CUSTOM').replace(/\\/g, '/');
            managedBasePaths.push(customRel + '/'); // "monitor_ap/CUSTOM/"
        }
    } else if (projectType === '970X') {
        const monitorApRel = findRelativeFolder(rootPath, 'monitor_ap', 3);
        if (monitorApRel) {
            const customRel = path.join(monitorApRel, 'CUSTOM').replace(/\\/g, '/');
            managedBasePaths.push(customRel + '/'); // "monitor_ap/CUSTOM/"
            const kernelSysRel = path.join(monitorApRel, 'KERNEL', 'SYSTEM').replace(/\\/g, '/');
            managedBasePaths.push(kernelSysRel + '/'); // "monitor_ap/KERNEL/SYSTEM/"
        }
    }

    // ---- 自动生成条目管理（独立文件，不污染 settings.json）----
    const managedFilePath = path.join(vscodeDir, 'cAutoConfig.managed.json');
    let managed: Record<string, string[]> = {};
    if (fs.existsSync(managedFilePath)) {
        try {
            managed = JSON.parse(fs.readFileSync(managedFilePath, 'utf-8'));
        } catch (_) { /* 忽略 */ }
    }

    // 辅助：从数组类型设置中移除被管理的旧值
    function removeManagedArray(targetKey: string) {
        const oldManaged: string[] = managed[targetKey] || [];
        if (oldManaged.length === 0) {return;}
        const arr: string[] = settings[targetKey] || [];
        settings[targetKey] = arr.filter((v: string) => !oldManaged.includes(v));
    }
    // 辅助：从对象类型设置中移除被管理的旧 key
    function removeManagedObject(targetKey: string) {
        const oldManaged: string[] = managed[targetKey] || [];
        if (oldManaged.length === 0) {return;}
        const obj: any = settings[targetKey] || {};
        for (const k of oldManaged) {delete obj[k];}
        settings[targetKey] = obj;
    }

    // 写 managed 到独立文件
    function saveManaged() {
        fs.writeFileSync(managedFilePath, JSON.stringify(managed, null, 2), 'utf-8');
    }

    // 2. 清理并更新 C_Cpp.files.exclude
    removeManagedObject('C_Cpp.files.exclude');
    if (!settings['C_Cpp.files.exclude']) {settings['C_Cpp.files.exclude'] = {};}
    const cppFilesExclude = settings['C_Cpp.files.exclude'];
    const newCppExcludeKeys: string[] = [];
    for (const p of excludePaths) {
        const normalized = p.replace(/\\/g, '/');
        const key = `${normalized}/**`;
        cppFilesExclude[key] = true;
        newCppExcludeKeys.push(key);
    }
    settings['C_Cpp.files.exclude'] = cppFilesExclude;
    managed['C_Cpp.files.exclude'] = newCppExcludeKeys;
    saveManaged();

    // 3. 清理并更新 search.exclude
    removeManagedObject('search.exclude');
    if (!settings['search.exclude']) {settings['search.exclude'] = {};}
    const searchExclude = settings['search.exclude'];
    const newSearchExcludeKeys: string[] = [];
    for (const p of excludePaths) {
        const normalized = p.replace(/\\/g, '/');
        const key = `${normalized}/**`;
        searchExclude[key] = true;
        newSearchExcludeKeys.push(key);
    }
    settings['search.exclude'] = searchExclude;
    managed['search.exclude'] = newSearchExcludeKeys;
    saveManaged();

    // 4. C_Cpp.default.systemIncludePath（先清除旧自动条目，再累加新条目）
    removeManagedArray('C_Cpp.default.systemIncludePath');
    if (!settings['C_Cpp.default.systemIncludePath']) {settings['C_Cpp.default.systemIncludePath'] = [];}
    const currentSystemInclude = settings['C_Cpp.default.systemIncludePath'];
    const cygwinRoot = vscode.workspace.getConfiguration('cAutoConfig').get<string>('cygwinRoot');
    const newSystemIncludeManaged: string[] = [];
    let includePaths: string[] = [];
    if (cygwinRoot) {
        includePaths = getCygwinIncludePaths(cygwinRoot);
        if (includePaths.length > 0 && outputChannel) {
            outputChannel.appendLine(`[调试] 设置 C_Cpp.default.systemIncludePath: ${includePaths.join(', ')}`);
        }
    }
    for (const incPath of includePaths) {
        if (!currentSystemInclude.includes(incPath)) {
            currentSystemInclude.push(incPath);
        }
        if (!newSystemIncludeManaged.includes(incPath)) {
            newSystemIncludeManaged.push(incPath);
        }
    }
    // 从 compile_commands.json 提取 -I 头文件路径
    const compileDbPath = path.join(rootPath, 'compile_commands.json');
    const extractedIncludeSet = new Set<string>();
    if (fs.existsSync(compileDbPath)) {
        try {
            const content = fs.readFileSync(compileDbPath, 'utf-8');
            const entries: any[] = JSON.parse(content);
            for (const entry of entries) {
                const tokens: string[] = [];
                if (entry.arguments && Array.isArray(entry.arguments)) {
                    tokens.push(...entry.arguments);
                } else if (entry.command) {
                    const parts = entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
                    if (parts) {tokens.push(...parts);}
                }
                const entryDir = entry.directory
                    ? (path.isAbsolute(entry.directory) ? entry.directory : path.resolve(rootPath, entry.directory))
                    : rootPath;
                for (const token of tokens) {
                    const iMatch = token.match(/^-I\s*(.+)$/);
                    if (iMatch) {
                        let incPathEntry = iMatch[1].trim();
                        if ((incPathEntry.startsWith('"') && incPathEntry.endsWith('"')) ||
                            (incPathEntry.startsWith("'") && incPathEntry.endsWith("'"))) {
                            incPathEntry = incPathEntry.slice(1, -1);
                        }
                        const resolved = path.isAbsolute(incPathEntry)
                            ? incPathEntry
                            : path.resolve(entryDir, incPathEntry);
                        extractedIncludeSet.add(resolved.replace(/\\/g, '/'));
                    }
                }
            }
        } catch (err) {
            if (outputChannel) {
                outputChannel.appendLine(`[警告] 解析 compile_commands.json 提取 include 路径失败: ${err}`);
            }
        }
    }
    for (const incPathEntry of extractedIncludeSet) {
        if (!currentSystemInclude.includes(incPathEntry)) {
            currentSystemInclude.push(incPathEntry);
        }
        if (!newSystemIncludeManaged.includes(incPathEntry)) {
            newSystemIncludeManaged.push(incPathEntry);
        }
    }
    settings['C_Cpp.default.systemIncludePath'] = currentSystemInclude;
    managed['C_Cpp.default.systemIncludePath'] = newSystemIncludeManaged;
    saveManaged();
    if (extractedIncludeSet.size > 0 && outputChannel) {
        outputChannel.appendLine(`  C_Cpp.default.systemIncludePath: 从 compile_commands.json 提取了 ${extractedIncludeSet.size} 个头文件路径（去重后新增）`);
    }

    // 5. 从 compile_commands.json 提取 -D 宏定义（先清除旧自动条目）
    removeManagedArray('C_Cpp.default.defines');
    const extractedDefines = new Set<string>();
    if (fs.existsSync(compileDbPath)) {
        try {
            const content = fs.readFileSync(compileDbPath, 'utf-8');
            const entries: any[] = JSON.parse(content);
            for (const entry of entries) {
                const tokens: string[] = [];
                if (entry.arguments && Array.isArray(entry.arguments)) {
                    tokens.push(...entry.arguments);
                } else if (entry.command) {
                    const parts = entry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
                    if (parts) {tokens.push(...parts);}
                }
                for (const token of tokens) {
                    const dMatch = token.match(/^-D\s*(.+)$/);
                    if (dMatch) {
                        let define = dMatch[1].trim();
                        if ((define.startsWith('"') && define.endsWith('"')) ||
                            (define.startsWith("'") && define.endsWith("'"))) {
                            define = define.slice(1, -1);
                        }
                        extractedDefines.add(define);
                    }
                }
            }
        } catch (err) {
            if (outputChannel) {
                outputChannel.appendLine(`[警告] 解析 compile_commands.json 提取 defines 失败: ${err}`);
            }
        }
    }
    const definesManaged: string[] = [];
    if (extractedDefines.size > 0) {
        if (!settings['C_Cpp.default.defines']) {settings['C_Cpp.default.defines'] = [];}
        const currentDefines = settings['C_Cpp.default.defines'] as string[];
        for (const def of extractedDefines) {
            if (!currentDefines.includes(def)) {
                currentDefines.push(def);
            }
            definesManaged.push(def);
        }
        settings['C_Cpp.default.defines'] = currentDefines;
        if (outputChannel) {
            outputChannel.appendLine(`  C_Cpp.default.defines: 从 compile_commands.json 提取了 ${extractedDefines.size} 个宏定义（去重后新增）`);
        }
    } else {
        if (outputChannel) {
            outputChannel.appendLine(`  C_Cpp.default.defines: 未从 compile_commands.json 提取到宏定义`);
        }
    }

    // 6. 从编译器中提取内置宏定义
    if (cygwinRoot) {
        const compilerDefines = await getCompilerBuiltinDefines(cygwinRoot, outputChannel);
        if (compilerDefines.length > 0) {
            if (!settings['C_Cpp.default.defines']) {settings['C_Cpp.default.defines'] = [];}
            const currentDefines = settings['C_Cpp.default.defines'] as string[];
            let addedCount = 0;
            for (const def of compilerDefines) {
                if (!currentDefines.includes(def)) {
                    currentDefines.push(def);
                    addedCount++;
                }
                if (!definesManaged.includes(def)) {
                    definesManaged.push(def);
                }
            }
            settings['C_Cpp.default.defines'] = currentDefines;
            if (outputChannel) {
                outputChannel.appendLine(`  C_Cpp.default.defines: 从编译器提取了 ${addedCount} 个内置宏定义（去重后新增）`);
            }
        } else {
            if (outputChannel) {
                outputChannel.appendLine(`  C_Cpp.default.defines: 未从编译器提取到内置宏定义`);
            }
        }
    }

    // 7. 追加固定的 GCC 兼容宏定义（帮助 IntelliSense 识别 GCC 特有关键字）
    const gccCompatDefines = [
        "__attribute__(x)=",
        "__attribute__(weak)=",
        "__attribute__(packed)=",
        "__attribute__(aligned(x))=",
        "__attribute__(section(x))=",
        "__attribute__(unused)=",
        "__attribute__(used)=",
        "__attribute__(deprecated)=",
        "__attribute__(noreturn)=",
        "__attribute__(always_inline)=",
        "__attribute__(noinline)=",
        "__attribute__(warn_unused_result)=",
        "__attribute__(format(x))=",
        "__attribute__(nonnull)=",
        "__attribute__(constructor)=",
        "__attribute__(destructor)=",
        "__attribute__(weakref)=",
        "__attribute__(visibility(x))=",
        "__inline=",
        "__inline__=",
        "__extension__=",
        "__restrict=",
        "__restrict__=",
        "__volatile__=",
        "__const__=",
        "__signed__=",
        "weak=",
        "packed=",
        "aligned=",
        "unused=",
        "used=",
        "noreturn=",
        "always_inline=",
        "noinline=",
    ];
    if (!settings['C_Cpp.default.defines']) {settings['C_Cpp.default.defines'] = [];}
    const currentDefinesFinal = settings['C_Cpp.default.defines'] as string[];
    let gccAddedCount = 0;
    for (const def of gccCompatDefines) {
        if (!currentDefinesFinal.includes(def)) {
            currentDefinesFinal.push(def);
            gccAddedCount++;
        }
        if (!definesManaged.includes(def)) {
            definesManaged.push(def);
        }
    }
    settings['C_Cpp.default.defines'] = currentDefinesFinal;
    if (outputChannel && gccAddedCount > 0) {
        outputChannel.appendLine(`  C_Cpp.default.defines: 追加了 ${gccAddedCount} 个 GCC 兼容宏定义`);
    }

    managed['C_Cpp.default.defines'] = definesManaged;
    saveManaged();

    // 写回 settings.json
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf-8');
    if (outputChannel) {
        outputChannel.appendLine(`已更新 ${settingsPath}`);
        outputChannel.appendLine(`  C_Cpp.files.exclude: 已清理旧规则，添加了 ${excludePaths.length} 条新规则`);
        outputChannel.appendLine(`  search.exclude: 已清理旧规则，添加了 ${excludePaths.length} 条新规则`);
        outputChannel.appendLine(`  C_Cpp.default.systemIncludePath: 添加了 ${includePaths.length} 个路径`);
    }
}