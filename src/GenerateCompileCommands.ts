import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { syncExcludeFolders } from './ExcludeManager/index';

// --- 模块内部状态 ---
export let outputChannel: vscode.OutputChannel;
export let isGenerating = false;

// 初始化输出通道（由主文件调用）
export function initOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

// 查找 Makefile（相对于根目录）
function findRelativeMakefilePath(rootDir: string): string | null {
    const queue: string[] = [''];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const currentRelativeDir = queue.shift()!;
        const currentFullPath = path.join(rootDir, currentRelativeDir);

        if (visited.has(currentFullPath)) {continue;}
        visited.add(currentFullPath);

        try {
            const files = fs.readdirSync(currentFullPath);
            const makefile = files.find(f => f.toLowerCase() === 'makefile');
            if (makefile) {
                return path.join(currentRelativeDir, makefile);
            }

            for (const file of files) {
                const filePath = path.join(currentRelativeDir, file);
                if (fs.statSync(path.join(rootDir, filePath)).isDirectory()) {
                    queue.push(filePath);
                }
            }
        } catch (error) {
            console.error(`无法读取目录: ${currentFullPath}`, error);
        }
    }
    return null;
}

// Windows 路径转 Cygwin 路径
function toCygwinPath(winPath: string): string {
    return winPath.replace(/^([A-Za-z]):\\/, (_, drive) => `/cygdrive/${drive.toLowerCase()}/`)
                  .replace(/\\/g, '/');
}

// 解析 make -n 输出生成 compile_commands.json
interface CompileEntry {
    directory: string;
    command: string;
    file: string;
}

function parseMakeOutput(output: string, makeDir: string): CompileEntry[] {
    const entries: CompileEntry[] = [];
    const lines = output.split('\n');
    // 已知编译器名称（匹配行首或空格前导）
    const compilerRe = /(?:^|\s)(?:aeon-gcc|gcc|g\+\+|clang|cc|c\+\+)(?:\s|$)/;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {continue;}

        // 必须包含 -c 标志（编译步骤，非链接）
        if (!line.includes(' -c ') && !line.endsWith(' -c')) {continue;}

        // 检查是否包含已知编译器名
        if (!compilerRe.test(line)) {continue;}

        // 提取源文件路径
        const sourceMatch = line.match(/(\S+\.(?:c|cpp|cc|cxx|S|s))\b/);
        if (!sourceMatch) {continue;}

        entries.push({
            directory: makeDir,
            command: line,
            file: sourceMatch[1],
        });
    }

    return entries;
}

// 核心生成逻辑
export async function handleGenerateAction() {
    if (isGenerating) {
        vscode.window.showWarningMessage('已有生成任务进行中，请稍后...');
        return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return vscode.window.showErrorMessage('请先打开一个文件夹工作区');
    }

    let rootPath: string | undefined;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (folder) {
            rootPath = folder.uri.fsPath;
        }
    }

    if (!rootPath) {
        if (folders.length === 1) {
            rootPath = folders[0].uri.fsPath;
        } else {
            const selected = await vscode.window.showQuickPick(
                folders.map(f => ({ label: f.name, folder: f })),
                { placeHolder: '检测到多个工作区根目录，请选择要生成 compile_commands.json 的目录' }
            );
            if (!selected) {return;}
            rootPath = selected.folder.uri.fsPath;
        }
    }

    if (!rootPath) {
        return vscode.window.showErrorMessage('无法确定工作区根目录');
    }

    if (!outputChannel) {
        return vscode.window.showErrorMessage('无法创建输出通道');
    }

    isGenerating = true;

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "正在生成 compile_commands.json...",
                cancellable: false,
            },
            async () => {
                const config = vscode.workspace.getConfiguration('cAutoConfig');
                const cygwinRootDir = config.get<string>('cygwinRoot') || 'D:\\cygwin';
                const cygwinBash = path.join(cygwinRootDir, 'bin', 'bash.exe');

                const relativeMakefile = findRelativeMakefilePath(rootPath);
                if (!relativeMakefile) {
                    throw new Error('未找到 Makefile');
                }

                const makefileDir = path.dirname(relativeMakefile);
                const cygwinRoot = toCygwinPath(rootPath);
                const cygwinMakeDir = toCygwinPath(path.join(rootPath, makefileDir));

                outputChannel.appendLine('运行 make -n 捕获编译命令...');

                const makeDirAbs = path.join(rootPath, makefileDir);
                const shellCmd = `cd "${cygwinMakeDir}"; make clean; make -n`;

                return new Promise<void>((resolve, reject) => {
                    const child = spawn(cygwinBash, ['-l', '-c', shellCmd], { cwd: rootPath });
                    let stdout = '';

                    child.stdout.on('data', (data) => {
                        stdout += data.toString();
                    });

                    child.stderr.on('data', (data) => {
                        let msg = data.toString();
                        const ignorePatterns = [
                            'find_fast_cwd: WARNING',
                            'Couldn\'t compute FAST_CWD pointer',
                            'Your group is currently "mkpasswd"',
                            '/etc/passwd',
                            '/etc/group'
                        ];
                        if (!ignorePatterns.some(pattern => msg.includes(pattern))) {
                            outputChannel.append(msg);
                        }
                    });

                    child.on('close', (code) => {
                        if (stdout.trim()) {
                            try {
                                const entries = parseMakeOutput(stdout, makeDirAbs);
                                const outPath = path.join(rootPath, 'compile_commands.json');
                                fs.writeFileSync(outPath, JSON.stringify(entries, null, 2), 'utf-8');
                                outputChannel.appendLine(`已生成 ${entries.length} 条编译命令`);
                                resolve();
                            } catch (err: any) {
                                reject(new Error(`解析编译命令失败: ${err.message}`));
                            }
                        } else {
                            reject(new Error(`make -n 未输出任何编译命令（退出码 ${code}）`));
                        }
                    });

                    child.on('error', (err) => {
                        reject(new Error(`启动进程失败: ${err.message}`));
                    });
                });
            }
        );

        outputChannel.appendLine('✅ compile_commands.json 生成成功');
        vscode.window.showInformationMessage('compile_commands.json 生成成功');
		// 同步文件夹排除规则
		await syncExcludeFolders(rootPath, outputChannel);
		// 可选提示（放在最后）
		vscode.window.showInformationMessage('compile_commands.json 生成成功，文件夹排除规则已应用');

    } catch (err: any) {
        outputChannel.appendLine(`❌ 生成失败: ${err.message}`);
        vscode.window.showErrorMessage(`生成失败: ${err.message}`);
    } finally {
        isGenerating = false;
    }
}