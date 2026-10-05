#define MyAppName "QIntellect Attendance Node"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "QIntellect Technologies"
#define MyAppExeName "QIntellectAttendanceNode.exe"

[Setup]
AppId={{7F38C80B-73AF-4B56-B27A-5C84C088A091}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\QIntellect Attendance Node
DefaultGroupName=QIntellect Attendance Node
OutputDir=..\artifacts
OutputBaseFilename=QIntellectAttendanceNodeSetup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "..\dist\QIntellectAttendanceNode.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\QIntellect Attendance Node"; Filename: "{app}\{#MyAppExeName}"
Name: "{commondesktop}\QIntellect Attendance Node"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch QIntellect Attendance Node"; Flags: nowait postinstall skipifsilent
