import * as vscode from 'vscode';
import { spawn, execSync } from 'child_process';
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

/** 检测 Python 绝对路径 */
function detectPythonExe(): string {
    try {
        const out = execSync(
            'python -c "import sys; print(sys.executable)"',
            { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' },
        );
        const p = String(out).trim();
        return p && fs.existsSync(p) ? p : '';
    } catch {
        return '';
    }
}

/** 用 Python 检测 compiledb 绝对路径 */
function detectCompiledbPath(pythonExe: string): string {
    if (!pythonExe) {return '';}
    try {
        const out = execSync(
            `"${pythonExe}" -c "import compiledb; import sysconfig; print(sysconfig.get_path('scripts'), end='')"`,
            { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' },
        );
        const candidate = path.join(String(out).trim(), 'compiledb.exe');
        return fs.existsSync(candidate) ? candidate : '';
    } catch {
        return '';
    }
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

                // 检测 Python 和 compiledb 的绝对路径，防止 PATH 问题
                const pythonExe = detectPythonExe();
                if (!pythonExe) {
                    throw new Error('未检测到 Python 环境，请安装 Python');
                }
                const cdbPath = detectCompiledbPath(pythonExe);
                if (!cdbPath) {
                    throw new Error('未检测到 compiledb，请运行: pip install compiledb');
                }
                // 转成 Cygwin 路径后在 bash 中使用
                const compiledbCmd = toCygwinPath(cdbPath);
                outputChannel.appendLine(`使用 compiledb: ${cdbPath}`);

				const needCopy = cygwinMakeDir !== cygwinRoot;
				const commands = [
					`rm -rf "${path.join(rootPath, 'compile_commands.json')}"`,
					`cd "${cygwinMakeDir}"`,
					`make clean`,
					`make -n > build.log`,
					`rm -f "${path.join(cygwinMakeDir, 'compile_commands.json')}"`,
					`PYTHONUTF8=1 "${compiledbCmd}" --parse build.log`,
					`rm -f build.log`
				];
				if (needCopy) {
					commands.push(`cp -f compile_commands.json "${cygwinRoot}/"`);
					commands.push(`rm -f compile_commands.json`);
				}
				const shellCmd = commands.join(' && ');
                outputChannel.appendLine(`执行: ${shellCmd}`);

                return new Promise<void>((resolve, reject) => {
                    const child = spawn(cygwinBash, ['-l', '-c', shellCmd], { cwd: rootPath });

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
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`进程退出码 ${code}`));
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