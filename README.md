# C Auto Config

Automatically generate `compile_commands.json` for C/C++ projects with multiple UI variants, and configure clangd / C/C++ extensions to ignore inactive UI folders.

## Features

- Auto-detect project type (MST9U7, MST9U6, 970X)
- Generate `compile_commands.json` using `compiledb`
- Exclude non-active UI folders from indexing (clangd, C/C++ plugin, search)
- Customizable `.clangd` template via VSCode settings

## Usage

1. Open your C/C++ project folder.
2. Run command **`C Auto Config: Generate compile_commands.json`**.
3. The plugin will automatically detect active UI variant and exclude others.

## Requirements

- Cygwin (for Windows) or any Unix-like environment with `make`, `compiledb` installed.
- VSCode with clangd or C/C++ extension.

## Configuration

- `cAutoConfig.cygwinPath`: Path to Cygwin bash.exe (Windows only).
- `cAutoConfig.clangdTemplate`: Custom `.clangd` template (optional).