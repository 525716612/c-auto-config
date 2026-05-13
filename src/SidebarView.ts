import * as vscode from 'vscode';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    // 必须与 package.json 中定义的视图 ID 一致
    public static readonly viewType = 'c-auto-config.webview';

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        // 允许脚本
        webviewView.webview.options = { enableScripts: true };
        
        // 设置 HTML 内容
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 监听 Webview 的消息（按钮点击）
        webviewView.webview.onDidReceiveMessage(data => {
            if (data.type === 'generateConfig') {
                // 这里只负责发消息，具体逻辑交给 extension.ts 处理
                vscode.commands.executeCommand('c-auto-config.generate');
            }
        });
    }

    // 专门负责生成 HTML 的私有方法
    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>C工程配置</title>
            <style>
                body { padding: 10px; font-family: var(--vscode-font-family); }
                h3 { margin-top: 0; color: var(--vscode-foreground); }
                p { color: var(--vscode-descriptionForeground); font-size: 12px; }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 8px 15px;
                    cursor: pointer;
                    width: 100%;
                    font-size: 13px;
                    margin-top: 10px;
                }
                button:hover { background-color: var(--vscode-button-hoverBackground); }
            </style>
        </head>
        <body>
            <h3>C工程工具箱</h3>
            <p>点击下方按钮执行生成逻辑。</p>
            <button id="genBtn">生成配置</button>
            <script>
                const btn = document.getElementById('genBtn');
                btn.addEventListener('click', () => {
                    const vscode = acquireVsCodeApi();
                    vscode.postMessage({ type: 'generateConfig' });
                });
            </script>
        </body>
        </html>`;
    }
}