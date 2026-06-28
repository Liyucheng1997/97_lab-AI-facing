@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "PYTHON_EXE=%PROJECT_DIR%vendor\python37\python.exe"
set "OPENPOSE_LOCAL=%PROJECT_DIR%vendor\openpose-cpu"
set "OPENPOSE_DRIVE=O:"
set "OPENPOSE_ROOT=%OPENPOSE_DRIVE%/"

if not exist "%PYTHON_EXE%" (
  echo Python 3.7 runtime not found: %PYTHON_EXE%
  exit /b 1
)

if not exist "%OPENPOSE_LOCAL%\bin\OpenPoseDemo.exe" (
  echo OpenPose not found: %OPENPOSE_LOCAL%
  exit /b 1
)

subst %OPENPOSE_DRIVE% /D >nul 2>nul
subst %OPENPOSE_DRIVE% "%OPENPOSE_LOCAL%"
if errorlevel 1 (
  echo Failed to mount %OPENPOSE_LOCAL% as %OPENPOSE_DRIVE%
  exit /b 1
)

"%PYTHON_EXE%" "%PROJECT_DIR%server\openpose_ws_server.py" --openpose-root "%OPENPOSE_ROOT%" --port 8765 --net-resolution=-1x128
