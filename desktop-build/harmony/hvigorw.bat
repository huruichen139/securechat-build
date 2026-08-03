@if "%DEBUG%" == "" @echo off
@rem ##########################################################################
@rem
@rem  SecureChat hvigor startup script (forwarder) for Windows
@rem  Forwards to the hvigorw bundled with DevEco Studio.
@rem
@rem ##########################################################################

@rem Set local scope for the variables with windows NT shell
if "%OS%"=="Windows_NT" setlocal

@rem Resolve project directory (where this script lives)
set DIRNAME=%~dp0
if "%DIRNAME%" == "" set DIRNAME=.
set APP_BASE_NAME=%~n0

@rem Location of the DevEco-bundled hvigor wrapper. Override with DEVECO_HVIGOR_HOME.
if not defined DEVECO_HVIGOR_HOME set DEVECO_HVIGOR_HOME=E:\Program Files\Huawei\DevEco Studio\tools\hvigor
set HVIGOR_HOME=%DEVECO_HVIGOR_HOME%

set WRAPPER_MODULE_PATH=%HVIGOR_HOME%\bin\hvigorw.js
set NODE_EXE=node.exe

@rem Optional node options
@rem set NODE_OPTS=--max-old-space-size=8192 --expose-gc

goto start

:start
if not defined NODE_OPTS set NODE_OPTS=--

@rem Find node.exe
if defined NODE_HOME goto findNodeFromNodeHome

%NODE_EXE% --version >NUL 2>&1
if "%ERRORLEVEL%" == "0" goto execute

echo.
echo ERROR: NODE_HOME is not set and no 'node' command could be found in your PATH.
echo.
echo Please set the NODE_HOME variable in your environment to match the
echo location of your NodeJs installation.
echo.
echo Hint: DevEco Studio ships Node at "E:\Program Files\Huawei\DevEco Studio\tools\node"
goto fail

:findNodeFromNodeHome
set NODE_HOME=%NODE_HOME:"=%
set NODE_EXE_PATH=%NODE_HOME%\%NODE_EXE%

if exist "%NODE_EXE_PATH%" goto execute
echo.
echo ERROR: NODE_HOME is set to an invalid directory.
echo NODE_HOME = %NODE_HOME%
echo.
echo Please set the NODE_HOME variable in your environment to match the
echo location of your NodeJs installation.
goto fail

:execute
@rem Execute hvigor
"%NODE_EXE%" %NODE_OPTS% "%WRAPPER_MODULE_PATH%" %*

if "%ERRORLEVEL%" == "0" goto hvigorwEnd

:fail
exit /b 1

:hvigorwEnd
if "%OS%" == "Windows_NT" endlocal

:end
