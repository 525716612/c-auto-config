import * as fs from 'fs';
import * as path from 'path';

function isFolderExistsWithinDepth(rootPath: string, targetName: string, maxDepth: number): boolean {
    const queue: { dirPath: string; depth: number }[] = [{ dirPath: rootPath, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
        const { dirPath, depth } = queue.shift()!;
        if (visited.has(dirPath)) {continue;}
        visited.add(dirPath);
        if (path.basename(dirPath) === targetName) {return true;}
        if (depth >= maxDepth) {continue;}
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (entry.name === targetName) {return true;}
                    queue.push({ dirPath: path.join(dirPath, entry.name), depth: depth + 1 });
                }
            }
        } catch (err) { /* 忽略 */ }
    }
    return false;
}

function findFolderPath(rootPath: string, targetName: string, maxDepth: number): string | null {
    const queue: { dirPath: string; depth: number }[] = [{ dirPath: rootPath, depth: 0 }];
    const visited = new Set<string>();
    while (queue.length > 0) {
        const { dirPath, depth } = queue.shift()!;
        if (visited.has(dirPath)) {continue;}
        visited.add(dirPath);
        if (path.basename(dirPath) === targetName) {return dirPath;}
        if (depth >= maxDepth) {continue;}
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (entry.name === targetName) {return path.join(dirPath, entry.name);}
                    queue.push({ dirPath: path.join(dirPath, entry.name), depth: depth + 1 });
                }
            }
        } catch (err) { /* 忽略 */ }
    }
    return null;
}

function has97Driver(rootPath: string): boolean {
    const monitorApPath = findFolderPath(rootPath, 'monitor_ap', 3);
    if (!monitorApPath) {return false;}
    const driverPath = path.join(monitorApPath, 'DRIVER');
    if (!fs.existsSync(driverPath) || !fs.statSync(driverPath).isDirectory()) {return false;}
    try {
        const entries = fs.readdirSync(driverPath, { withFileTypes: true });
        return entries.some(entry => entry.isDirectory() && entry.name.startsWith('97'));
    } catch {
        return false;
    }
}

export function detectProjectType(rootPath: string): string {
    if (isFolderExistsWithinDepth(rootPath, 'MST9U7', 2)) {
        return 'MST9U7';
    }
    if (has97Driver(rootPath)) {
        return '970X';
    }
    return 'MST9U6';
}