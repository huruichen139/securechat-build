using System.Windows;

namespace SecureChat;

public partial class App : Application
{
    private Mutex? _mutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _mutex = new Mutex(true, "SecureChat.SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("SecureChat 已在运行。", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        base.OnStartup(e);
        AppState.Load();

        if (AppState.TryRedirectToLatestVersion(out string? latestPath))
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(latestPath!)
            {
                WorkingDirectory = Path.GetDirectoryName(latestPath) ?? ""
            });
            Shutdown();
            return;
        }

        var login = new LoginWindow();
        login.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _mutex?.Dispose();
        base.OnExit(e);
    }
}
