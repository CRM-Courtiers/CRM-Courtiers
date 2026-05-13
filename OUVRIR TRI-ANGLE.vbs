Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Client\Dropbox (Compte personnel)\CRM Pro\electron-app"
WshShell.Run "npx electron .", 0, False
