using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;

namespace SecureChat;

public static class AppState
{
    public static string ServerHost { get; set; } = "https://mc.32768.top:8888";
    public static string Token { get; set; } = "";
    public static UserInfo? Me { get; set; }
    public static bool AllowInvalidCert { get; set; } = true;
    public static bool AutoUpdate { get; set; } = true;

    public const string AppVersion = "1.25.0";

    private static string BaseDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SecureChat");

    public static string VersionsDir => Path.Combine(BaseDir, "versions");
    public static string CurrentTxt => Path.Combine(BaseDir, "current.txt");
    public static string SettingsFile => Path.Combine(BaseDir, "settings.json");

    public static string WsUrl
    {
        get
        {
            var host = ServerHost.TrimEnd('/');
            return host.Replace("https://", "wss://").Replace("http://", "ws://") + "/ws";
        }
    }

    public static void Load()
    {
        try
        {
            if (!File.Exists(SettingsFile)) return;
            var root = JsonNode.Parse(File.ReadAllText(SettingsFile)) as JsonObject;
            if (root == null) return;
            ServerHost = root["serverHost"]?.GetValue<string>() ?? ServerHost;
            Token = root["token"]?.GetValue<string>() ?? "";
            AllowInvalidCert = root["allowInvalidCert"]?.GetValue<bool>() ?? AllowInvalidCert;
            AutoUpdate = root["autoUpdate"]?.GetValue<bool>() ?? AutoUpdate;
        }
        catch { }
    }

    public static void Save()
    {
        try
        {
            Directory.CreateDirectory(BaseDir);
            var root = new JsonObject
            {
                ["serverHost"] = ServerHost,
                ["token"] = Token,
                ["allowInvalidCert"] = AllowInvalidCert,
                ["autoUpdate"] = AutoUpdate
            };
            File.WriteAllText(SettingsFile, root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    public static bool TryRedirectToLatestVersion(out string? latestPath)
    {
        latestPath = null;
        try
        {
            var exePath = Environment.ProcessPath ?? "";
            if (string.IsNullOrEmpty(exePath)) return false;
            var exeDir = Path.GetDirectoryName(exePath) ?? "";
            if (exeDir.StartsWith(VersionsDir, StringComparison.OrdinalIgnoreCase)) return false;

            if (!File.Exists(CurrentTxt)) return false;
            var latest = File.ReadAllText(CurrentTxt).Trim();
            if (!Version.TryParse(latest, out _)) return false;
            if (Version.Parse(latest) <= Version.Parse(AppVersion)) return false;

            var candidate = Path.Combine(VersionsDir, "v" + latest, "SecureChat.exe");
            if (File.Exists(candidate))
            {
                latestPath = candidate;
                return true;
            }
        }
        catch { }
        return false;
    }

    public static HttpMessageHandler CreateHandler()
    {
        var handler = new HttpClientHandler
        {
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        if (AllowInvalidCert)
        {
            handler.ServerCertificateCustomValidationCallback =
                (HttpRequestMessage req, X509Certificate2? cert, X509Chain? chain, SslPolicyErrors errors) => true;
        }
        return handler;
    }

    public static bool IsCertificateValid(object? sender, X509Certificate? cert, X509Chain? chain, SslPolicyErrors errors)
        => AllowInvalidCert || errors == SslPolicyErrors.None;
}
