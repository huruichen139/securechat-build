#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

namespace {

// 单实例互斥量：若已有一个实例在运行，则把 securechat:// 深链参数
// 通过 WM_COPYDATA 转发给已运行实例后退出，避免重复启动。
constexpr wchar_t kSingleInstanceMutexName[] = L"SecureChat_SingleInstance_Mutex";
constexpr wchar_t kWindowClassName[] = L"FLUTTER_RUNNER_WIN32_WINDOW";
constexpr wchar_t kWindowTitle[] = L"securechat";

HANDLE g_single_instance_mutex = nullptr;

// 把深链 URL 转发给已运行的主实例。找到窗口则激活并返回 true。
bool ForwardDeeplinkToRunningInstance(const std::vector<std::string>& args) {
  std::wstring url;
  for (const auto& a : args) {
    if (a.rfind("securechat://", 0) == 0) {
      url = Utf8ToUtf16(a);
      break;
    }
  }

  // 窗口可能刚创建还没就绪，稍等片刻再找。
  HWND target = nullptr;
  for (int i = 0; i < 40 && target == nullptr; i++) {
    target = ::FindWindowW(kWindowClassName, kWindowTitle);
    if (target == nullptr) {
      ::Sleep(50);
    }
  }
  if (target == nullptr) {
    return false;
  }

  ::SetForegroundWindow(target);
  if (!url.empty()) {
    COPYDATASTRUCT cds{};
    cds.dwData = kDeeplinkCopyDataId;
    cds.cbData = static_cast<DWORD>((url.size() + 1) * sizeof(wchar_t));
    cds.lpData = const_cast<wchar_t*>(url.c_str());
    ::SendMessageW(target, WM_COPYDATA,
                   static_cast<WPARAM>(::GetCurrentProcessId()),
                   reinterpret_cast<LPARAM>(&cds));
  }
  return true;
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  // 单实例：已有实例在运行时，把深链转发过去并退出本进程。
  g_single_instance_mutex = ::CreateMutexW(nullptr, TRUE, kSingleInstanceMutexName);
  if (g_single_instance_mutex != nullptr &&
      ::GetLastError() == ERROR_ALREADY_EXISTS) {
    ForwardDeeplinkToRunningInstance(command_line_arguments);
    ::CloseHandle(g_single_instance_mutex);
    g_single_instance_mutex = nullptr;
    ::CoUninitialize();
    return EXIT_SUCCESS;
  }

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"securechat", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
