import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findRelativeFolder, getSourceRelativePaths, updateClangdExclude, updateSettingsExclude } from './common';

export async function handleMST9U6(rootPath: string, outputChannel?: vscode.OutputChannel): Promise<void> {
    const monitorApRel = findRelativeFolder(rootPath, 'monitor_ap', 3);
    if (!monitorApRel) {
        if (outputChannel) {outputChannel.appendLine('[警告] 未找到 monitor_ap 文件夹');}
        return;
    }
    const customRel = path.join(monitorApRel, 'CUSTOM').replace(/\\/g, '/');
    const customFull = path.join(rootPath, customRel);
    if (!fs.existsSync(customFull)) {
        if (outputChannel) {outputChannel.appendLine('[警告] CUSTOM 文件夹不存在');}
        return;
    }
    const allSubdirs = fs.readdirSync(customFull, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    if (outputChannel) {outputChannel.appendLine(`[调试] CUSTOM 下所有子文件夹: ${allSubdirs.join(', ')}`);}
    const uiSubdirs = allSubdirs.filter(name => name !== 'COMMON');
    if (uiSubdirs.length === 0) {
        if (outputChannel) {outputChannel.appendLine('[调试] 没有 UI 子文件夹，无需排除');}
        return;
    }
    const compileDbPath = path.join(rootPath, 'compile_commands.json');
    const sourceFiles = getSourceRelativePaths(compileDbPath, rootPath, outputChannel);
    const activeSet = new Set<string>();
    const customPrefix = customRel + '/';
    for (const src of sourceFiles) {
        if (src.startsWith(customPrefix)) {
            const afterCustom = src.substring(customPrefix.length);
            const slashIdx = afterCustom.indexOf('/');
            const sub = slashIdx === -1 ? afterCustom : afterCustom.substring(0, slashIdx);
            if (sub && sub !== 'COMMON') {
                activeSet.add(sub);
                if (outputChannel) {outputChannel.appendLine(`[调试] 从 ${src} -> 活动 UI 子文件夹: ${sub}`);}
            }
        }
    }
    let activeUISubfolder: string | null = null;
    if (activeSet.size === 1) {
        activeUISubfolder = Array.from(activeSet)[0];
        if (outputChannel) {outputChannel.appendLine(`[调试] 唯一活动 UI 子文件夹: ${activeUISubfolder}`);}
    } else if (activeSet.size > 1) {
        if (outputChannel) {outputChannel.appendLine(`[警告] 多个活动 UI 子文件夹: ${Array.from(activeSet).join(', ')}，使用第一个`);}
        activeUISubfolder = Array.from(activeSet)[0];
    } else {
        if (outputChannel) {outputChannel.appendLine('[错误] 未从源文件中检测到任何活动 UI 子文件夹，将不排除任何 UI 子文件夹');}
        activeUISubfolder = null;
    }
    const excludePaths: string[] = [];
    if (activeUISubfolder) {
        for (const sub of uiSubdirs) {
            if (sub !== activeUISubfolder) {
                const subRel = path.join(customRel, sub).replace(/\\/g, '/');
                excludePaths.push(subRel);
                if (outputChannel) {outputChannel.appendLine(`[调试] 排除非活动 UI 子文件夹: ${subRel}`);}
            }
        }
    } else {
        if (outputChannel) {outputChannel.appendLine('[调试] 未检测到活动 UI 子文件夹，跳过排除');}
    }
    if (excludePaths.length > 0) {
        await Promise.all([
            updateClangdExclude(rootPath, excludePaths, outputChannel),
            updateSettingsExclude(rootPath, excludePaths, outputChannel)
        ]);
        if (outputChannel) {outputChannel.appendLine(`✅ 已为 ${excludePaths.length} 个未活动的文件夹禁用 clangd 和 C/C++ 插件的索引/搜索`);}
    } else {
        if (outputChannel) {outputChannel.appendLine(`✅ 已完成，没有需要排除的文件夹`);}
    }
}