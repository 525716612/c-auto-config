import * as vscode from 'vscode';
import { handleMST9U7 } from './mst9u7';
import { handleMST9U6 } from './mst9u6';
import { handle970X } from './x970';
import { detectProjectType } from '../ProjectDetector';
import { debugLog } from './common';

export async function syncExcludeFolders(
    rootPath: string,
    outputChannel?: vscode.OutputChannel
): Promise<void> {
    const projectType = detectProjectType(rootPath);
    debugLog(outputChannel, `工程类型: ${projectType}`);

    if (projectType === 'MST9U7') {
        await handleMST9U7(rootPath, outputChannel);
    } else if (projectType === '970X') {
        await handle970X(rootPath, outputChannel);
    } else { // MST9U6
        await handleMST9U6(rootPath, outputChannel);
    }

    if (outputChannel) {
        outputChannel.appendLine(`💡 提示：文件夹在资源管理器中仍然可见，但 clangd、C/C++ 插件和全局搜索将忽略它们。`);
    }
}