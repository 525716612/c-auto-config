import * as vscode from 'vscode';
import { SidebarViewProvider } from './SidebarView';
import { handleGenerateAction, initOutputChannel } from './GenerateCompileCommands';


export function activate(context: vscode.ExtensionContext) {
    // 创建输出通道并初始化到模块中
    const channel = vscode.window.createOutputChannel('C Auto Config');
    initOutputChannel(channel);
    console.log('C Auto Config 插件已激活');

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('c-auto-config.generate', () => {
            handleGenerateAction();
        })
    );

    // 注册侧边栏
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('c-auto-config.webview', sidebarProvider)
    );
}

export function deactivate() {
    // 可选清理
}