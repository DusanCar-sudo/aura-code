; ─────────────────────────────────────────────────────────────────────────────
; Aura — Windows installer (Inno Setup 6)
;
; Native Windows. This used to install the Linux build into WSL, because the
; shell guardrails were POSIX strings and a native run recognised none of
; `del /s /q`, `rd /s`, `format`, or `Remove-Item -Recurse -Force`, while
; auto-approving nothing. Both lists now screen cmd.exe and PowerShell
; (config/defaults.ts), so the WSL detour is no longer buying anything and the
; installer is an ordinary one: a private Node runtime, the app, a launcher on
; PATH.
;
; Payload comes from packaging\windows\stage-windows.ps1, which must run first.
;
; Build:  iscc /DAppVersion=0.12.2 packaging\windows\aura.iss
; ─────────────────────────────────────────────────────────────────────────────

#define AppName        "Aura"
; Version comes from the build script, which reads package.json. The fallback
; only exists so the script can be opened in the Inno IDE.
#ifndef AppVersion
  #define AppVersion   "0.0.0-dev"
#endif
#ifndef StageDir
  #define StageDir     "..\..\build\stage-win"
#endif
#define AppPublisher   "Dusan Milosavljevic"
#define AppURL         "https://github.com/DusanCar-sudo/aura-code"

[Setup]
AppId={{8C4E2A91-5B3D-4F7E-9A21-6D8F0C3B7E45}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\Aura
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\build\dist
OutputBaseFilename=AuraCode-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Installing per-user avoids a UAC prompt and lets PATH be the user's own,
; which is the variable a plain `aura` in a terminal actually resolves against.
PrivilegesRequired=lowest
LicenseFile=..\..\LICENSE
; Tells Explorer to broadcast the environment change, so a newly opened
; terminal sees `aura` without a sign-out.
ChangesEnvironment=yes
UninstallDisplayName={#AppName} {#AppVersion}
UninstallDisplayIcon={app}\aura.cmd

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add Aura to PATH (recommended)"; GroupDescription: "Integration:"

[Files]
; recursesubdirs + createallsubdirs: the staged tree is a real directory
; structure (runtime, app, node_modules), not a flat file list.
Source: "{#StageDir}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\app\*";  DestDir: "{app}\app";  Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\aura.cmd"; DestDir: "{app}";    Flags: ignoreversion
Source: "..\..\README.md";      DestDir: "{app}";    Flags: ignoreversion isreadme
Source: "..\..\LICENSE";        DestDir: "{app}";    Flags: ignoreversion

[Icons]
Name: "{group}\Aura Setup"; Filename: "{app}\aura.cmd"; Parameters: "setup --web"; \
  Comment: "Choose a provider and enter an API key"
Name: "{group}\Aura"; Filename: "{app}\aura.cmd"; \
  Comment: "Start Aura in the current folder"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; The wizard is a browser page rather than a terminal prompt: someone who has
; just clicked through an installer should not be dropped into a TUI.
Filename: "{app}\aura.cmd"; Parameters: "setup --web"; \
  Description: "Configure Aura now (choose provider, enter API key)"; \
  Flags: postinstall shellexec nowait skipifsilent

[Code]
const
  EnvKey = 'Environment';

{ True when Dir is not already a PATH entry. Compared with delimiters on both
  sides so that C:\Tools\Aura is not treated as present because C:\Tools\Aura2
  happens to be. }
function NeedsAddPath(const Dir: string): Boolean;
var
  Existing: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Existing) then
  begin
    Result := True;
    Exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Existing) + ';') = 0;
end;

procedure AddToPath(const Dir: string);
var
  Existing: string;
begin
  if not NeedsAddPath(Dir) then
    Exit;
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Existing) then
    Existing := '';
  if (Existing <> '') and (Existing[Length(Existing)] <> ';') then
    Existing := Existing + ';';
  { expandsz, because a user PATH commonly contains %USERPROFILE% and rewriting
    it as a plain string would freeze those references at today's values. }
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Existing + Dir);
end;

procedure RemoveFromPath(const Dir: string);
var
  Existing, Cleaned: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Existing) then
    Exit;
  Cleaned := ';' + Existing + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Cleaned));
  if P = 0 then
    Exit;
  Delete(Cleaned, P, Length(Dir) + 1);
  { Strip the delimiters this function added, leaving the user's own PATH
    shape intact rather than accumulating stray semicolons across upgrades. }
  if (Length(Cleaned) > 0) and (Cleaned[1] = ';') then Delete(Cleaned, 1, 1);
  if (Length(Cleaned) > 0) and (Cleaned[Length(Cleaned)] = ';') then
    Delete(Cleaned, Length(Cleaned), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Cleaned);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then
    AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  { Uninstalling has to undo the PATH entry as well; Inno does not track
    registry values written from code, so leaving this out would strand a
    dead directory on every user's PATH forever. }
  if CurUninstallStep = usUninstall then
    RemoveFromPath(ExpandConstant('{app}'));
end;
