import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'c-auto-config.webview';
    private _extensionVersion: string;
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {
        // 从扩展的 package.json 读取版本号
        try {
            const pkgPath = path.join(_extensionUri.fsPath, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            this._extensionVersion = pkg.version || '0.0.0';
        } catch {
            this._extensionVersion = '0.0.0';
        }
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            if (data.type === 'generateConfig') {
                vscode.commands.executeCommand('c-auto-config.generate');
            } else if (data.type === 'checkStatus') {
                this._sendStatus(webviewView);
            } else if (data.type === 'openSettings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'cAutoConfig.cygwinRoot');
            } else if (data.type === 'clearCompileCommands') {
                vscode.workspace.getConfiguration('C_Cpp').update('default.compileCommands', undefined, vscode.ConfigurationTarget.Workspace);
                this._sendStatus(webviewView);
            }
        });

        // 首次加载时延迟发送状态（让 webview 先渲染）
        setTimeout(() => this._sendStatus(webviewView), 500);

        // 监听 cAutoConfig 设置变更，自动刷新状态
        this._disposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cAutoConfig')) {
                if (this._view) {
                    this._sendStatus(this._view);
                }
            }
        });
    }

    private _disposable?: vscode.Disposable;

    private _sendStatus(webviewView: vscode.WebviewView) {
        // 检查 Python
        let pythonOk = false;
        try {
            execSync('python --version', { stdio: 'pipe', windowsHide: true });
            pythonOk = true;
        } catch { /* 未安装 */ }

        // 检查 compiledb（通过 pip show 或直接运行命令）
        let compiledbOk = false;
        if (pythonOk) {
            try {
                execSync('compiledb --version', { stdio: 'pipe', windowsHide: true });
                compiledbOk = true;
            } catch {
                // 备用：通过 pip 检查
                try {
                    const pipOut = execSync('pip show compiledb', { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' });
                    compiledbOk = pipOut.includes('compiledb');
                } catch { /* 未安装 */ }
            }
        }

        // 检查 cygwinRoot
        const cygwinRoot = vscode.workspace.getConfiguration('cAutoConfig').get<string>('cygwinRoot');
        const cygwinOk = !!cygwinRoot && fs.existsSync(cygwinRoot);

        // 检查 compilerPath（如果有配置）
        const compilerPath = vscode.workspace.getConfiguration('cAutoConfig').get<string>('compilerPath');
        const defaultCompiler = cygwinRoot ? path.join(cygwinRoot, 'opt', 'aeon', 'bin', 'aeon-gcc.exe') : '';
        const compilerToCheck = compilerPath || defaultCompiler;
        const compilerOk = !!compilerToCheck && fs.existsSync(compilerToCheck);

        // 检查 .vscode/settings.json 中是否显式配置了 C_Cpp.default.compileCommands
        let compileCommandsPath = '';
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            for (const folder of workspaceFolders) {
                const settingsPath = path.join(folder.uri.fsPath, '.vscode', 'settings.json');
                if (fs.existsSync(settingsPath)) {
                    try {
                        const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                        const val = content['C_Cpp.default.compileCommands'];
                        if (typeof val === 'string' && val.trim()) {
                            compileCommandsPath = val;
                            break;
                        }
                    } catch { /* 忽略 */ }
                }
            }
        }
        const hasCompileCommandsConfig = !!compileCommandsPath;

        webviewView.webview.postMessage({
            type: 'status',
            pythonOk,
            compiledbOk,
            cygwinOk,
            cygwinRoot: cygwinRoot || '',
            compilerOk,
            hasCompileCommandsConfig,
            compileCommandsPath: compileCommandsPath || '',
        });
    }

    public dispose() {
        this._disposable?.dispose();
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>C工程配置</title>
            <style>
                :root {
                    --card-bg: var(--vscode-editor-background, #252526);
                    --border: var(--vscode-editorWidget-border, #454545);
                    --text: var(--vscode-foreground, #cccccc);
                    --text-secondary: var(--vscode-descriptionForeground, #888);
                    --success: #4ec9b0;
                    --warning: #dcdcaa;
                    --error: #f44747;
                }
                body {
                    padding: 16px;
                    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
                    font-size: 13px;
                    color: var(--text);
                    line-height: 1.5;
                }
                .header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 16px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid var(--border);
                }
                .header-icon {
                    width: 32px;
                    height: 32px;
                    background: linear-gradient(135deg, #4ec9b0, #2d7d9a);
                    border-radius: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    color: #fff;
                    flex-shrink: 0;
                }
                .header-text h2 {
                    margin: 0;
                    font-size: 15px;
                    font-weight: 600;
                }
                .header-text p {
                    margin: 2px 0 0;
                    font-size: 11px;
                    color: var(--text-secondary);
                }

                /* 状态卡片 */
                .status-card {
                    background: var(--card-bg);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 10px;
                }
                .status-card h4 {
                    margin: 0 0 8px;
                    font-size: 12px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: var(--text-secondary);
                }
                .status-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 4px 0;
                }
                .status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    flex-shrink: 0;
                }
                .status-dot.ok { background: var(--success); }
                .status-dot.warn { background: var(--warning); }
                .status-dot.err { background: var(--error); }
                .status-label { flex: 1; font-size: 12px; }
                .status-detail {
                    font-size: 11px;
                    color: var(--text-secondary);
                    word-break: break-all;
                }

                /* 提示框 */
                .tip-box {
                    background: color-mix(in srgb, var(--warning) 15%, transparent);
                    border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 10px;
                    font-size: 12px;
                }
                .tip-box strong { color: var(--warning); }
                .tip-box code {
                    background: rgba(0,0,0,0.3);
                    padding: 1px 5px;
                    border-radius: 3px;
                    font-size: 11px;
                }
                .tip-box a {
                    color: var(--vscode-textLink-foreground, #3794ff);
                    cursor: pointer;
                    text-decoration: underline;
                }
                .tip-box a:hover { color: var(--vscode-textLink-activeForeground, #5aa3ff); }
                .tip-box.open {
                    background: color-mix(in srgb, var(--success) 15%, transparent);
                    border-color: color-mix(in srgb, var(--success) 30%, transparent);
                }
                .tip-box.open strong { color: var(--success); }

                /* 按钮 */
                .btn-primary {
                    background: linear-gradient(135deg, #4ec9b0, #3a9d8f);
                    color: #fff;
                    border: none;
                    border-radius: 8px;
                    padding: 12px 20px;
                    cursor: pointer;
                    width: 100%;
                    font-size: 14px;
                    font-weight: 500;
                    transition: opacity 0.2s, transform 0.1s;
                    margin-top: 6px;
                }
                .btn-primary:hover { opacity: 0.9; }
                .btn-primary:active { transform: scale(0.98); }
                .btn-primary:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                    transform: none;
                }
                .btn-secondary {
                    background: var(--vscode-editor-background, #252526);
                    color: var(--text);
                    border: 1px solid var(--border);
                    border-radius: 8px;
                    padding: 12px 14px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: 500;
                    transition: opacity 0.2s, transform 0.1s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .btn-secondary:hover {
                    opacity: 0.8;
                    border-color: var(--success);
                }
                .btn-secondary:active { transform: scale(0.98); }

                /* 脚注 */
                .footer {
                    margin-top: 16px;
                    padding-top: 10px;
                    border-top: 1px solid var(--border);
                    font-size: 11px;
                    color: var(--text-secondary);
                    text-align: center;
                }
                .footer a {
                    color: var(--vscode-textLink-foreground, #3794ff);
                    cursor: pointer;
                }

                .hidden { display: none; }
            </style>
        </head>
        <body>
            <!-- 头部 -->
            <div class="header">
                <div class="header-icon">&#9881;</div>
                <div class="header-text">
                    <h2>C工程工具箱</h2>
                    <p>一键生成 compile_commands.json 与 VS Code 配置</p>
                </div>
            </div>

            <!-- 状态卡片 -->
            <div class="status-card">
                <h4>环境检查</h4>
                <div class="status-item">
                    <span class="status-dot" id="dotPython"></span>
                    <span class="status-label">Python</span>
                    <span class="status-detail" id="detailPython">检查中...</span>
                </div>
                <div class="status-item">
                    <span class="status-dot" id="dotCygwin"></span>
                    <span class="status-label">Cygwin 根目录</span>
                    <span class="status-detail" id="detailCygwin">检查中...</span>
                </div>
                <div class="status-item">
                    <span class="status-dot" id="dotCompiler"></span>
                    <span class="status-label">编译器 (aeon-gcc)</span>
                    <span class="status-detail" id="detailCompiler">检查中...</span>
                </div>
                <div class="status-item">
                    <span class="status-dot" id="dotCompiledb"></span>
                    <span class="status-label">compiledb</span>
                    <span class="status-detail" id="detailCompiledb">检查中...</span>
                </div>
            </div>

            <!-- compile_commands.json 路径冲突警告 -->
            <div id="tipCompileCommands" class="tip-box hidden" style="border-color:color-mix(in srgb, var(--error) 30%, transparent);background:color-mix(in srgb, var(--error) 12%, transparent);">
                <strong style="color:var(--error)">&#9888; 检测到 compile_commands.json 配置</strong>
                <p style="margin:4px 0">
                    设置 <code>C_Cpp.default.compileCommands</code> 已指向：<br>
                    <span id="compileCommandsPath" style="word-break:break-all;font-size:11px"></span>
                </p>
                <p style="margin:4px 0;font-size:12px">
                    此配置与本插件管理的 compile_commands.json 可能冲突，建议清除该设置让插件管理。
                </p>
                <p style="margin:6px 0 0">
                    <a onclick="clearCompileCommands()">&#10132; 清除该设置</a>
                    &nbsp;&middot;&nbsp;
                    <a onclick="openCompileCommandsSettings()">&#10132; 查看设置</a>
                </p>
            </div>

            <!-- 操作指引（按检测项分别提示） -->
            <div id="tipHelpPython" class="tip-box hidden" style="border-color:color-mix(in srgb, var(--error) 30%, transparent);background:color-mix(in srgb, var(--error) 12%, transparent);">
                <strong style="color:var(--error)">&#9888; Python 未安装</strong>
                <p style="margin:4px 0">compiledb 需要 Python 环境，请安装 Python 并确保 <code>python</code> 命令可用。</p>
                <p style="margin:4px 0">
                    <a href="https://www.python.org/downloads/" target="_blank">&#10132; 前往 python.org 下载</a>
                </p>
            </div>

            <div id="tipHelpCompiledb" class="tip-box hidden" style="border-color:color-mix(in srgb, var(--error) 30%, transparent);background:color-mix(in srgb, var(--error) 12%, transparent);">
                <strong style="color:var(--error)">&#9888; compiledb 未安装</strong>
                <p style="margin:4px 0">compiledb 用于从构建日志生成 <code>compile_commands.json</code>。</p>
                <p style="margin:4px 0">
                    请在终端中运行：<br>
                    <code style="display:inline-block;margin-top:2px">pip install compiledb</code>
                </p>
            </div>

            <div id="tipHelpCygwin" class="tip-box hidden" style="border-color:color-mix(in srgb, var(--error) 30%, transparent);background:color-mix(in srgb, var(--error) 12%, transparent);">
                <strong style="color:var(--error)">&#9888; Cygwin 根目录未配置</strong>
                <p style="margin:4px 0">请在 VS Code 设置中配置 <code>cAutoConfig.cygwinRoot</code>，插件会自动拼接编译器路径。</p>
                <p style="margin:6px 0 0">
                    <a onclick="openSettings()">&#10132; 打开设置</a>
                </p>
            </div>

            <div id="tipHelpCompiler" class="tip-box hidden" style="border-color:color-mix(in srgb, var(--warning) 30%, transparent);background:color-mix(in srgb, var(--warning) 12%, transparent);">
                <strong style="color:var(--warning)">&#9888; 编译器 (aeon-gcc) 未找到</strong>
                <p style="margin:4px 0">
                    未在默认路径 <code>&lt;cygwinRoot&gt;/opt/aeon/bin/aeon-gcc.exe</code> 找到编译器。<br>
                    可通过 <code>cAutoConfig.compilerPath</code> 指定其他路径。
                </p>
                <p style="margin:6px 0 0">
                    <a onclick="openSettings()">&#10132; 打开设置</a>
                </p>
            </div>

            <!-- 一切就绪提示 -->
            <div id="tipReady" class="tip-box open hidden">
                <strong>&#10004; 环境就绪</strong>
                <p style="margin:4px 0 0">所有依赖已满足，可以开始生成配置。</p>
            </div>

            <!-- 操作按钮组 -->
            <div style="display:flex;gap:6px;margin-top:6px">
                <button class="btn-primary" id="genBtn" style="flex:1">&#9654; 生成配置</button>
                <button class="btn-secondary" id="refreshBtn" title="重新检测环境状态">&#8635;</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();

                document.getElementById('genBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'generateConfig' });
                });

                document.getElementById('refreshBtn').addEventListener('click', () => {
                    document.getElementById('detailPython').textContent = '检测中...';
                    document.getElementById('detailCygwin').textContent = '检测中...';
                    document.getElementById('detailCompiler').textContent = '检测中...';
                    document.getElementById('detailCompiledb').textContent = '检测中...';
                    vscode.postMessage({ type: 'checkStatus' });
                });

                function openSettings() {
                    vscode.postMessage({ type: 'openSettings' });
                }

                function clearCompileCommands() {
                    vscode.postMessage({ type: 'clearCompileCommands' });
                }

                function openCompileCommandsSettings() {
                    vscode.postMessage({ type: 'openSettings' });
                }

                // 监听状态更新
                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.type !== 'status') return;

                    // Python
                    const dotPy = document.getElementById('dotPython');
                    const detailPy = document.getElementById('detailPython');
                    dotPy.className = 'status-dot ' + (msg.pythonOk ? 'ok' : 'err');
                    detailPy.textContent = msg.pythonOk ? '已安装' : '未安装';

                    // Cygwin
                    const dotCyg = document.getElementById('dotCygwin');
                    const detailCyg = document.getElementById('detailCygwin');
                    dotCyg.className = 'status-dot ' + (msg.cygwinOk ? 'ok' : 'err');
                    detailCyg.textContent = msg.cygwinOk ? msg.cygwinRoot : '未配置';

                    // Compiler
                    const dotComp = document.getElementById('dotCompiler');
                    const detailComp = document.getElementById('detailCompiler');
                    dotComp.className = 'status-dot ' + (msg.compilerOk ? 'ok' : (msg.cygwinOk ? 'warn' : 'err'));
                    detailComp.textContent = msg.compilerOk ? '可用' : (msg.cygwinOk ? '未找到' : '依赖 Cygwin');

                    // compiledb
                    const dotCdb = document.getElementById('dotCompiledb');
                    const detailCdb = document.getElementById('detailCompiledb');
                    dotCdb.className = 'status-dot ' + (msg.compiledbOk ? 'ok' : 'err');
                    detailCdb.textContent = msg.compiledbOk ? '已安装' : (msg.pythonOk ? '未安装 (pip install compiledb)' : '依赖 Python');

                    // compile_commands.json 配置警告
                    const tipCC = document.getElementById('tipCompileCommands');
                    const pathSpan = document.getElementById('compileCommandsPath');
                    if (msg.hasCompileCommandsConfig) {
                        tipCC.classList.remove('hidden');
                        pathSpan.textContent = msg.compileCommandsPath;
                    } else {
                        tipCC.classList.add('hidden');
                    }

                    // 按检测项分别显示操作指引
                    document.getElementById('tipHelpPython').classList.toggle('hidden', msg.pythonOk);
                    document.getElementById('tipHelpCompiledb').classList.toggle('hidden', msg.compiledbOk);
                    document.getElementById('tipHelpCygwin').classList.toggle('hidden', msg.cygwinOk);
                    document.getElementById('tipHelpCompiler').classList.toggle('hidden', msg.compilerOk);

                    // 一切就绪提示
                    const allOk = msg.pythonOk && msg.cygwinOk && msg.compilerOk && msg.compiledbOk;
                    document.getElementById('tipReady').classList.toggle('hidden', !allOk);
                    document.getElementById('genBtn').disabled = !allOk;
                });

                // 请求状态检查
                vscode.postMessage({ type: 'checkStatus' });
            </script>

            <div class="footer">
                C Auto Config v${this._extensionVersion} &middot; 
                <a onclick="openSettings()">设置</a>
            </div>
        </body>
        </html>`;
    }
}