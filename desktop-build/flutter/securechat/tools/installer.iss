; Inno Setup 脚本：将 Flutter Windows Release 打包为安装程序。
; 用法（在本工程根目录）：
;   ISCC.exe tools\installer.iss /dAppVer=1.25.0
; 产物：dist\SecureChat-<AppVer>-windows.exe（文件名匹配服务器 PLATFORM_FILES）

#define MyAppName "SecureChat"
#define MyAppExe "securechat.exe"
#ifndef AppVer
  #define AppVer "1.25.0"
#endif
#define MyAppPublisher "SecureChat"
#define MyAppURL "https://mc.32768.top"

[Setup]
AppId={{6F1B3D0A-7E2C-4A8B-9D5F-SECURECHAT0001}
AppName={#MyAppName}
AppVersion={#AppVer}
AppVerName={#MyAppName} {#AppVer}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=..\dist
OutputBaseFilename=SecureChat-{#AppVer}-windows
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExe}
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
DisableProgramGroupPage=auto
CloseApplications=no

[Languages]
; GitHub runner 的 Inno Setup 未打包中文语言文件，这里仅用 English 以避免缺失报错。
; 如需中文界面，可把 ChineseSimplified.isl 复制进 runner 的 Languages 目录后再加上。
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
