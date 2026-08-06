using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Input;

namespace SecureChat;

public partial class LoginWindow : Window
{
    private bool _busy;
    private System.Threading.Timer? _codeTimer;
    private int _countdown;

    public LoginWindow()
    {
        InitializeComponent();
        ServerBox.Text = AppState.ServerHost;
        AllowCertBox.IsChecked = AppState.AllowInvalidCert;
        Loaded += (_, _) =>
        {
            AccountBox.Focus();
            _ = CheckVersionSilentlyAsync();
        };
    }

    private void ApplyServerSettings()
    {
        var host = ServerBox.Text.Trim().TrimEnd('/');
        if (string.IsNullOrEmpty(host)) return;
        if (!host.StartsWith("http"))
        {
            if (AllowCertBox.IsChecked == true) host = "https://" + host;
            else host = "https://" + host;
        }
        if (host != AppState.ServerHost)
        {
            AppState.ServerHost = host;
            ApiClient.ResetClient();
        }
        AppState.AllowInvalidCert = AllowCertBox.IsChecked == true;
        AppState.Save();
    }

    private void SetBusy(bool busy, string? msg = null)
    {
        _busy = busy;
        ErrorText.Text = msg ?? "";
        PasswordLoginBtn.IsEnabled = !busy;
        CodeLoginBtn.IsEnabled = !busy;
        SendCodeBtn.IsEnabled = !busy;
        ScanBtn.IsEnabled = !busy;
        QrLoginBtn.IsEnabled = !busy;
    }

    private async Task<bool> TryLoginAsync(LoginResult result)
    {
        if (result.Error != null)
        {
            ErrorText.Text = result.Error;
            return false;
        }
        if (string.IsNullOrEmpty(result.Token) || result.User == null)
        {
            ErrorText.Text = "登录失败：服务器返回数据异常";
            return false;
        }
        ApplyServerSettings();
        AppState.Token = result.Token;
        AppState.Me = result.User;
        AppState.Save();

        var main = new MainWindow();
        main.Show();
        Close();
        return true;
    }

    private void PasswordLogin_Click(object sender, RoutedEventArgs e) => _ = DoPasswordLoginAsync();
    private void PasswordBox_KeyDown(object sender, KeyEventArgs e) { if (e.Key == Key.Enter) _ = DoPasswordLoginAsync(); }

    private async Task DoPasswordLoginAsync()
    {
        if (_busy) return;
        var account = AccountBox.Text.Trim();
        var password = PasswordBox.Password;
        if (string.IsNullOrEmpty(account) || string.IsNullOrEmpty(password))
        {
            ErrorText.Text = "请输入用户名/邮箱和密码";
            return;
        }
        SetBusy(true, "正在登录…");
        var result = await ApiClient.LoginPasswordAsync(account, password);
        SetBusy(false);
        await TryLoginAsync(result);
    }

    private void CodeBox_KeyDown(object sender, KeyEventArgs e) { if (e.Key == Key.Enter) _ = DoCodeLoginAsync(); }

    private async void SendCode_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var email = EmailBox.Text.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(email, "^[^@]+@[^@]+\\.[^@]+$"))
        {
            ErrorText.Text = "邮箱格式错误";
            return;
        }
        SendCodeBtn.IsEnabled = false;
        var (ok, err) = await ApiClient.RequestEmailCodeAsync(email);
        if (!ok)
        {
            ErrorText.Text = err ?? "验证码发送失败";
            SendCodeBtn.IsEnabled = true;
            return;
        }
        ErrorText.Text = "验证码已发送至 " + email + "，10 分钟内有效";
        StartCountdown();
    }

    private void StartCountdown()
    {
        _countdown = 60;
        SendCodeBtn.Content = "60s";
        _codeTimer?.Dispose();
        _codeTimer = new System.Threading.Timer(_ =>
        {
            _countdown--;
            Dispatcher.BeginInvoke(() =>
            {
                if (_countdown <= 0)
                {
                    _codeTimer?.Dispose();
                    SendCodeBtn.Content = "获取验证码";
                    SendCodeBtn.IsEnabled = true;
                }
                else
                {
                    SendCodeBtn.Content = _countdown + "s";
                }
            });
        }, null, 1000, 1000);
    }

    private void CodeLogin_Click(object sender, RoutedEventArgs e) => _ = DoCodeLoginAsync();

    private async Task DoCodeLoginAsync()
    {
        if (_busy) return;
        var email = EmailBox.Text.Trim();
        var code = CodeBox.Text.Trim();
        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(code))
        {
            ErrorText.Text = "请输入邮箱和验证码";
            return;
        }
        SetBusy(true, "正在登录…");
        var result = await ApiClient.LoginCodeAsync(email, code);
        SetBusy(false);
        await TryLoginAsync(result);
    }

    private void Scan_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        var scanner = new QrScannerWindow { Owner = this };
        if (scanner.ShowDialog() == true && !string.IsNullOrEmpty(scanner.QrText))
        {
            QrTokenBox.Text = scanner.QrText;
            _ = DoQrLoginAsync(scanner.QrText);
        }
    }

    private void QrTokenBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) _ = DoQrLoginAsync(QrTokenBox.Text);
    }

    private void QrLogin_Click(object sender, RoutedEventArgs e) => _ = DoQrLoginAsync(QrTokenBox.Text);

    private async Task DoQrLoginAsync(string text)
    {
        if (_busy || string.IsNullOrWhiteSpace(text)) return;
        var token = ExtractQrToken(text.Trim());
        if (token == null)
        {
            ErrorText.Text = "无法识别授权链接，请扫描「我 → 扫码登录授权」里的二维码";
            return;
        }
        SetBusy(true, "正在确认扫码授权…");
        var result = await ApiClient.QrConsumeAsync(token);
        SetBusy(false);
        await TryLoginAsync(result);
    }

    private static string? ExtractQrToken(string text)
    {
        if (text.StartsWith("securechat://login?token="))
            return Uri.UnescapeDataString(text.Substring("securechat://login?token=".Length));
        if (Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            foreach (var pair in uri.Query.TrimStart('?').Split('&'))
            {
                var parts = pair.Split('=');
                if (parts.Length == 2 && parts[0] == "token" && !string.IsNullOrEmpty(parts[1]))
                    return Uri.UnescapeDataString(parts[1]);
            }
        }
        if (text.Length >= 16 && text.All(c => c == '-' || char.IsLetterOrDigit(c) || c == '.'))
            return text;
        return null;
    }

    private void OpenWeb_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Process.Start(new ProcessStartInfo(AppState.ServerHost + "/") { UseShellExecute = true });
        }
        catch { }
    }

    private async Task CheckVersionSilentlyAsync()
    {
        try
        {
            var info = await ApiClient.GetVersionAsync();
            if (info == null) return;
            if (UpdateService.IsNewer(AppState.AppVersion, info.Latest))
                Dispatcher.BeginInvoke(() =>
                {
                    var r = MessageBox.Show(this,
                        "发现新版本 v" + info.Latest + "\n\n" + (info.ReleaseNotes ?? "") + "\n\n是否立即更新？",
                        "SecureChat 更新", MessageBoxButton.YesNo, MessageBoxImage.Information);
                    if (r == MessageBoxResult.Yes)
                        _ = InstallUpdateAsync(info);
                });
        }
        catch { }
    }

    private async Task InstallUpdateAsync(VersionInfo info)
    {
        var url = UpdateService.LatestDownloadUrl(info);
        if (string.IsNullOrEmpty(url))
        {
            MessageBox.Show(this, "服务器暂未提供 Windows 更新包。", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        SetBusy(true, "正在下载更新…");
        try
        {
            var progress = new Progress<double>(p => ErrorText.Text = $"正在下载更新… {p * 100:F0}%");
            var pkg = await UpdateService.DownloadPackageAsync(url, info.Latest, progress, CancellationToken.None);
            var exe = pkg == null ? null : UpdateService.ExtractToExe(pkg, info.Latest);
            if (exe == null || !File.Exists(exe))
            {
                ErrorText.Text = "更新包解压失败";
                return;
            }
            UpdateService.MarkLatest(info.Latest);
            UpdateService.LaunchAndExit(exe);
            Application.Current.Shutdown();
        }
        catch (Exception ex)
        {
            ErrorText.Text = "更新失败：" + ex.Message;
            SetBusy(false);
        }
    }
}
