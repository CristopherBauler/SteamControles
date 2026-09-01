' SteamControles.vbs — launcher silencioso (sem janela de CMD).
' Nao fixe este .vbs na barra: o Windows mostra "Windows Script Host".
' Use o atalho SteamControles.lnk (botao no app) ou dist\SteamControles.exe.

Option Explicit
Dim fso, sh, root, electron, distExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
distExe = root & "\dist\SteamControles.exe"
electron = root & "\node_modules\electron\dist\electron.exe"

If fso.FileExists(distExe) Then
  sh.Run """" & distExe & """", 1, False
ElseIf fso.FileExists(electron) Then
  ' electron.exe sem argumentos abre a tela de boas-vindas do Electron.
  sh.Run """" & electron & """ """ & root & """", 1, False
Else
  sh.Run """" & root & "\SteamControles.bat""", 1, False
End If
