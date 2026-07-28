; ─────────────────────────────────────────────────────────────────────────────
; Aura — Windows installer (Inno Setup 6)
;
; Windows support is WSL-based. Aura's shell guardrails are POSIX strings, so
; a native Windows install would auto-approve nothing and its dangerous-command
; denylist would miss `del /s /q`, `rd /s`, `format`, and
; `Remove-Item -Recurse -Force`. Rather than ship that, this installer puts the
; Linux build inside the user's WSL distro and leaves Windows-side shortcuts
; that launch through wsl.exe.
;
; So the payload here is small: the .deb, a couple of scripts, and the
; shortcuts. The heavy lifting happens inside WSL at install time.
;
; Build:  iscc packaging\windows\aura.iss
; Expects build\dist\aura-code_<version>_all.deb to exist (make -C packaging deb).
; ─────────────────────────────────────────────────────────────────────────────

#define AppName        "Aura"
; Version comes from the build script, which reads package.json:
;   iscc /DAppVersion=0.12.2 aura.iss
; The fallback only exists so the script can be opened in the Inno IDE.
#ifndef AppVersion
  #define AppVersion   "0.0.0-dev"
#endif
#define AppPublisher   "Dusan Milosavljevic"
#define AppURL         "https://github.com/DusanCar-sudo/aura-code"
#define DebFile        "aura-code_" + AppVersion + "_all.deb"

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
; WSL is 64-bit only.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\build\dist\{#DebFile}"; DestDir: "{app}"; Flags: ignoreversion
Source: "install-into-wsl.sh";         DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md";             DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
; Shortcuts run through wsl.exe — there is no Windows-native aura binary.
Name: "{group}\Aura Setup";   Filename: "wsl.exe"; Parameters: "aura setup --web"; Comment: "Choose a provider and enter an API key"
Name: "{group}\Aura Shell";   Filename: "wsl.exe"; Parameters: "--cd ~ -- bash -lc ""aura; exec bash"""; Comment: "Open a shell with Aura ready"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Install into WSL, then open the setup page. Both are shown as wizard
; checkboxes so an offline user can skip and do it later.
Filename: "wsl.exe"; \
  Parameters: "-- bash -lc ""bash '$(wslpath '{app}\install-into-wsl.sh')' '$(wslpath '{app}\{#DebFile}')'"""; \
  StatusMsg: "Installing Aura into WSL (this downloads Node if needed)..."; \
  Flags: shellexec waituntilterminated; \
  Check: WSLIsReady

Filename: "wsl.exe"; Parameters: "aura setup --web"; \
  Description: "Configure Aura now (choose provider, enter API key)"; \
  Flags: postinstall shellexec nowait skipifsilent; \
  Check: WSLIsReady

[Code]
var
  WSLAvailable: Boolean;
  WSLChecked: Boolean;

{ Run a command and capture whether it succeeded. }
function RunHidden(const Cmd, Params: string; var ResultCode: Integer): Boolean;
begin
  Result := Exec(Cmd, Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

{ True when WSL exists AND has at least one installed distribution.
  `wsl.exe -l -q` exits non-zero when WSL is present but has no distro, which
  is the case that would otherwise fail confusingly halfway through install. }
function DetectWSL(): Boolean;
var
  Code: Integer;
begin
  Result := False;
  if not FileExists(ExpandConstant('{sys}\wsl.exe')) then
    Exit;
  if RunHidden(ExpandConstant('{sys}\wsl.exe'), '-l -q', Code) then
    Result := (Code = 0);
end;

function WSLIsReady(): Boolean;
begin
  if not WSLChecked then
  begin
    WSLAvailable := DetectWSL();
    WSLChecked := True;
  end;
  Result := WSLAvailable;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not WSLIsReady() then
  begin
    { Explain rather than silently installing something that cannot run.
      Continuing is allowed: the files land on disk and the user can finish
      after enabling WSL. }
    Result := MsgBox(
      'Aura on Windows runs inside WSL (Windows Subsystem for Linux), which does'  #13#10
      'not appear to be set up on this PC.'                                        #13#10 #13#10
      'Aura''s command-safety rules are written for Linux shells. Running it'      #13#10
      'natively on Windows would stop for confirmation on every command and'      #13#10
      'would not recognise destructive commands such as del /s /q or'             #13#10
      'Remove-Item -Recurse -Force. So WSL is required, not merely preferred.'    #13#10 #13#10
      'To set it up, open PowerShell as Administrator and run:'                    #13#10 #13#10
      '    wsl --install'                                                          #13#10 #13#10
      'Restart when prompted, then run this installer again.'                      #13#10 #13#10
      'Continue anyway and finish setup later?',
      mbConfirmation, MB_YESNO) = IDYES;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and (not WSLIsReady()) then
    MsgBox(
      'Files were copied, but Aura was not installed into WSL.'          #13#10 #13#10
      'Once WSL is available, open a WSL terminal and run:'              #13#10 #13#10
      '    bash "' + ExpandConstant('{app}') + '\install-into-wsl.sh"'   #13#10 #13#10
      '(or reinstall Aura and it will do this for you).',
      mbInformation, MB_OK);
end;
