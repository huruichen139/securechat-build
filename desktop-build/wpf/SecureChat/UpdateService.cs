using System.Diagnostics;
using System.IO;
using System.IO.Compression;

namespace SecureChat;

public static class UpdateService
{
    public static int[] ParseVersion(string v)
    {
        var parts = (v ?? "0.0.0").Split('.');
        var arr = new int[3];
        for (int i = 0; i < 3 && i < parts.Length; i++)
            int.TryParse(parts[i], out arr[i]);
        return arr;
    }

    public static bool IsNewer(string current, string candidate)
    {
        var a = ParseVersion(current);
        var b = ParseVersion(candidate);
        for (int i = 0; i < 3; i++)
        {
            if (b[i] > a[i]) return true;
            if (b[i] < a[i]) return false;
        }
        return false;
    }

    public static string LatestDownloadUrl(VersionInfo info)
    {
        // 优先 windowsPortable zip（自动更新用），回退 windows exe
        if (info.Downloads.TryGetValue("windowsPortable", out var zip) && !string.IsNullOrEmpty(zip)) return zip;
        if (info.Downloads.TryGetValue("windows", out var exe) && !string.IsNullOrEmpty(exe)) return exe;
        return "";
    }

    public static async Task<string?> DownloadPackageAsync(string relativeUrl, string version, IProgress<double>? progress, CancellationToken ct)
    {
        var dir = Path.Combine(AppState.VersionsDir, "v" + version);
        Directory.CreateDirectory(dir);
        var url = AppState.ServerHost.TrimEnd('/') + relativeUrl;
        var fileName = Path.GetFileName(new Uri(url).AbsolutePath);
        if (string.IsNullOrEmpty(fileName)) fileName = "package.bin";
        var tempFile = Path.Combine(dir, fileName + ".part");
        var finalFile = Path.Combine(dir, fileName);

        using var client = ApiClient.Http;
        using var resp = await client.GetAsync(new Uri(url), HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        var total = resp.Content.Headers.ContentLength ?? 0;
        long done = 0;
        await using var src = await resp.Content.ReadAsStreamAsync(ct);
        await using var dst = File.Create(tempFile);
        var buffer = new byte[256 * 1024];
        int read;
        while ((read = await src.ReadAsync(buffer, ct)) > 0)
        {
            await dst.WriteAsync(buffer.AsMemory(0, read), ct);
            done += read;
            if (total > 0) progress?.Report((double)done / total);
        }
        await dst.FlushAsync(ct);
        File.Move(tempFile, finalFile, true);
        return finalFile;
    }

    public static string? ExtractToExe(string packagePath, string version)
    {
        var dir = Path.Combine(AppState.VersionsDir, "v" + version);
        Directory.CreateDirectory(dir);
        try
        {
            if (packagePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                ZipFile.ExtractToDirectory(packagePath, dir, overwriteFiles: true);
            }
            else
            {
                var target = Path.Combine(dir, Path.GetFileName(packagePath));
                File.Copy(packagePath, target, true);
            }
            var exe = Directory.GetFiles(dir, "SecureChat.exe", SearchOption.AllDirectories).FirstOrDefault();
            return exe;
        }
        catch
        {
            return null;
        }
    }

    public static void MarkLatest(string version) => File.WriteAllText(AppState.CurrentTxt, version);

    public static void LaunchAndExit(string exePath)
    {
        var psi = new ProcessStartInfo(exePath)
        {
            WorkingDirectory = Path.GetDirectoryName(exePath) ?? "",
            UseShellExecute = true
        };
        try { Process.Start(psi); } catch { }
    }
}
