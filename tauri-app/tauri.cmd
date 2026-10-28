@echo off
rem Runs the Tauri CLI (e.g. `tauri.cmd dev`, `tauri.cmd build`) inside the VS 2019 C++
rem environment. On this PC the VS 2022 toolset is missing its x64 libraries, and Rust
rem picks VS 2022 by default, so linking fails with LNK1104 'msvcrt.lib' without this.
setlocal

rem vcvars64.bat adds a few thousand characters to PATH and cmd.exe can't handle lines
rem over 8191, so a long PATH (Anaconda, CUDA, ...) fails with "The input line is too
rem long". Building only needs Windows, Node and Cargo, so start from a short PATH.
rem (The app finds ani-cli and mpv through the registry PATH, so `tauri dev` still works.)
set "NODE_DIR="
for %%I in (node.exe) do set "NODE_DIR=%%~dp$PATH:I"
if not defined NODE_DIR set "NODE_DIR=%ProgramFiles%\nodejs\"
set "CARGO_DIR=%USERPROFILE%\.cargo\bin"
if defined CARGO_HOME set "CARGO_DIR=%CARGO_HOME%\bin"
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%NODE_DIR%;%CARGO_DIR%"

set "VCVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VCVARS%" call "%VCVARS%" >nul
cd /d "%~dp0"
call npx tauri %*
