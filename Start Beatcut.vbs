' Starts Beatcut's local helper (hidden) and opens it in your browser.
' First run: sets up Python packages (yt-dlp finds clips, ffmpeg joins video + audio).
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
dir = fs.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If Not fs.FileExists(dir & "\.venv\Scripts\pythonw.exe") Then
  MsgBox "First start: setting up Beatcut. This takes about a minute.", 64, "Beatcut"
  sh.Run "cmd /c py -3 -m venv .venv && .venv\Scripts\python -m pip install -q yt-dlp imageio-ffmpeg faster-whisper numpy", 1, True
End If
' if it's already running, the second copy just exits and the browser still opens
sh.Run """" & dir & "\.venv\Scripts\pythonw.exe"" server.py", 0, False
WScript.Sleep 1500
sh.Run "http://localhost:8796"
' keep yt-dlp current (YouTube changes often) and add anything a newer Beatcut needs; applies next start
sh.Run """" & dir & "\.venv\Scripts\python.exe"" -m pip install -q -U yt-dlp faster-whisper numpy", 0, False
