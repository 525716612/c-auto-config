import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { findRelativeFolder, getSourceRelativePaths, updateSettingsExclude, updateClangdExclude, debugLog } from './common';

export async function handleMST9U7(rootPath: string, outputChannel?: vscode.OutputChannel): Promise<void> {
    const commonRel = findRelativeFolder(rootPath, 'COMMON', 2);
    if (!commonRel) {
        if (outputChannel) {outputChannel.appendLine('[警告] 未找到 COMMON 文件夹');}
        return;
    }
    const osdRel = path.join(commonRel, 'OSD').replace(/\\/g, '/');
    debugLog(outputChannel, `OSD 相对路径: ${osdRel}`);

    const osdFull = path.join(rootPath, osdRel);
    if (!fs.existsSync(osdFull)) {
        if (outputChannel) {outputChannel.appendLine('[警告] OSD 文件夹不存在');}
        return;
    }
    const allSubdirs = fs.readdirSync(osdFull, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    debugLog(outputChannel, `OSD 所有子文件夹: ${allSubdirs.join(', ')}`);
    if (allSubdirs.length === 0) {
        debugLog(outputChannel, 'OSD 下无子文件夹，无需排除');
        return;
    }

    const uiSubdirs = allSubdirs.filter(name => name !== 'COMMON');
    debugLog(outputChannel, `UI 子文件夹: ${uiSubdirs.join(', ')}`);
    if (uiSubdirs.length === 0) {
        debugLog(outputChannel, '没有 UI 子文件夹，无需排除');
        return;
    }

    const compileDbPath = path.join(rootPath, 'compile_commands.json');
    const sourceFiles = getSourceRelativePaths(compileDbPath, rootPath, outputChannel);
    debugLog(outputChannel, `找到 ${sourceFiles.length} 个源文件`);

    const activeSet = new Set<string>();
    const osdPrefix = osdRel + '/';
    for (const src of sourceFiles) {
        if (src.startsWith(osdPrefix)) {
            const afterOsd = src.substring(osdPrefix.length);
            const slashIdx = afterOsd.indexOf('/');
            const sub = slashIdx === -1 ? afterOsd : afterOsd.substring(0, slashIdx);
            if (sub && sub !== '' && sub !== 'COMMON') {
                activeSet.add(sub);
                debugLog(outputChannel, `从 ${src} -> 活动 UI 子文件夹: ${sub}`);
            }
        }
    }

    let activeUISubfolder: string | null = null;
    if (activeSet.size === 1) {
        activeUISubfolder = Array.from(activeSet)[0];
        debugLog(outputChannel, `唯一活动 UI 子文件夹: ${activeUISubfolder}`);
    } else if (activeSet.size > 1) {
        if (outputChannel) {outputChannel.appendLine(`[警告] 多个活动 UI 子文件夹: ${Array.from(activeSet).join(', ')}，使用第一个`);}
        activeUISubfolder = Array.from(activeSet)[0];
    } else {
        if (outputChannel) {outputChannel.appendLine('[错误] 未从源文件中检测到任何活动 UI 子文件夹，将不排除任何 UI 子文件夹');}
        activeUISubfolder = null;
    }

    const excludePaths: string[] = [];

    // 排除非活动的 OSD 下 UI 子文件夹
    if (activeUISubfolder) {
        for (const sub of uiSubdirs) {
            if (sub !== activeUISubfolder) {
                const subRel = path.join(osdRel, sub).replace(/\\/g, '/');
                excludePaths.push(subRel);
                debugLog(outputChannel, `排除非活动 OSD UI 子文件夹: ${subRel}`);
            }
        }
    } else {
        debugLog(outputChannel, '未检测到活动 UI 子文件夹，跳过排除 OSD 下 UI 子文件夹');
    }

    // 处理 CUSTOM/Mediatek 相关排除
    const customRel = findRelativeFolder(rootPath, 'CUSTOM', 3);
    if (!customRel) {
        debugLog(outputChannel, '未找到 CUSTOM 文件夹，跳过 Mediatek 相关排除');
    } else {
        const mediatekBase = path.join(customRel, 'Mediatek').replace(/\\/g, '/');
        const customMediatekDirs = ['UI', 'USERDATA', 'USERFUN', 'ZUI'];
        const isActiveMediatek = (activeUISubfolder === 'Mediatek');
        if (!isActiveMediatek && activeUISubfolder !== null) {
            for (const dir of customMediatekDirs) {
                const fullPath = path.join(mediatekBase, dir).replace(/\\/g, '/');
                if (fs.existsSync(path.join(rootPath, fullPath))) {
                    if (!excludePaths.includes(fullPath)) {
                        excludePaths.push(fullPath);
                        debugLog(outputChannel, `额外排除非 Mediatek 活动的文件夹: ${fullPath}`);
                    }
                } else {
                    debugLog(outputChannel, `路径不存在，跳过: ${fullPath}`);
                }
            }
        } else if (isActiveMediatek) {
            debugLog(outputChannel, '活动 UI 是 Mediatek，不排除 CUSTOM/Mediatek 下的文件夹');
        }
    }

    if (excludePaths.length > 0) {
        await Promise.all([
            updateClangdExclude(rootPath, excludePaths, outputChannel),
            updateSettingsExclude(rootPath, excludePaths, 'MST9U7', outputChannel)
        ]);
        if (outputChannel) {outputChannel.appendLine(`✅ 已为 ${excludePaths.length} 个未活动的文件夹禁用 clangd 和 C/C++ 插件的索引/搜索`);}
    } else {
        if (outputChannel) {outputChannel.appendLine(`✅ 已完成，没有需要排除的文件夹`);}
    }
}