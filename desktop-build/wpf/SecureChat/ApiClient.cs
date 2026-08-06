using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SecureChat;

public static class JsonUtil
{
    public static string? Str(this JsonObject? o, string key) => o?[key]?.GetValue<string>();
    public static long Lng(this JsonObject? o, string key) => o?[key]?.GetValue<long>() ?? 0;
    public static bool Bool(this JsonObject? o, string key) => o?[key]?.GetValue<bool>() ?? false;
    public static JsonObject? Obj(this JsonObject? o, string key) => o?[key] as JsonObject;
    public static JsonArray? Arr(this JsonObject? o, string key) => o?[key] as JsonArray;
}

public static class ApiClient
{
    private static readonly Lazy<HttpClient> LazyHttp = new(() =>
        new HttpClient(new SocketsHttpHandler
        {
            UseCookies = false,
            AutomaticDecompression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Deflate,
            SslOptions = new System.Net.Security.SslClientAuthenticationOptions
            {
                RemoteCertificateValidationCallback = AppState.IsCertificateValid
            }
        })
        {
            Timeout = TimeSpan.FromSeconds(60)
        });

    public static HttpClient Http => LazyHttp.Value;

    public static void ResetClient()
    {
        if (LazyHttp.IsValueCreated) LazyHttp.Value.Dispose();
    }

    private static HttpRequestMessage Build(string method, string path, object? body, bool auth)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), AppState.ServerHost.TrimEnd('/') + path);
        if (auth && !string.IsNullOrEmpty(AppState.Token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AppState.Token);
        if (body != null)
        {
            req.Content = new StringContent(body is string s ? s : JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        }
        return req;
    }

    public static async Task<(bool ok, int status, JsonObject? data, string? error)> SendAsync(string method, string path, object? body = null, bool auth = true)
    {
        try
        {
            using var req = Build(method, path, body, auth);
            using var resp = await Http.SendAsync(req);
            var text = await resp.Content.ReadAsStringAsync();
            int status = (int)resp.StatusCode;
            JsonObject? data = null;
            string? error = null;
            try { data = JsonNode.Parse(text) as JsonObject; } catch { }
            if (!resp.IsSuccessStatusCode)
                error = data?.Str("error") ?? $"HTTP {status}";
            return (resp.IsSuccessStatusCode, status, data, error);
        }
        catch (Exception ex)
        {
            return (false, 0, null, "无法连接服务器：" + ex.Message);
        }
    }

    public static async Task<byte[]> GetBytesAsync(string path, bool auth = true)
    {
        using var req = Build("GET", path, null, auth);
        using var resp = await Http.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadAsByteArrayAsync();
    }

    public static Task<(bool, int, JsonObject?, string?)> Post(string path, object? body, bool auth = true)
        => SendAsync("POST", path, body, auth);
    public static Task<(bool, int, JsonObject?, string?)> Get(string path, bool auth = true)
        => SendAsync("GET", path, null, auth);

    public static JsonObject? ToJson(object o) => JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(o)) as JsonObject;

    // ---------- 业务 API ----------

    public static async Task<LoginResult> LoginPasswordAsync(string account, string password)
    {
        var (ok, _, data, err) = await Post("/api/login", new { account, password }, auth: false);
        if (!ok) return new LoginResult { Error = err };
        return new LoginResult { Token = data?.Str("token"), User = ParseUser(data?.Obj("user")) };
    }

    public static async Task<LoginResult> LoginCodeAsync(string email, string code)
    {
        var (ok, _, data, err) = await Post("/api/login/code", new { email, code }, auth: false);
        if (!ok) return new LoginResult { Error = err };
        return new LoginResult { Token = data?.Str("token"), User = ParseUser(data?.Obj("user")) };
    }

    public static async Task<(bool ok, string? error)> RequestEmailCodeAsync(string email)
    {
        var (ok, _, _, err) = await Post("/api/email/code", new { email, purpose = "login" }, auth: false);
        return (ok, err);
    }

    public static async Task<LoginResult> QrConsumeAsync(string token)
    {
        var (ok, status, data, err) = await Post("/api/login/qr/consume", new { token }, auth: false);
        if (!ok) return new LoginResult { Error = status == 410 ? "二维码已过期，请重新生成" : err };
        if (data?.Str("status") != "ok")
            return new LoginResult { Error = "二维码尚未被授权，请先在已登录设备确认" };
        return new LoginResult { Token = data?.Str("token"), User = ParseUser(data?.Obj("user")) };
    }

    public static UserInfo? ParseUser(JsonObject? u)
    {
        if (u == null) return null;
        return new UserInfo
        {
            Id = u.Lng("id"),
            Username = u.Str("username"),
            Nickname = u.Str("nickname"),
            Avatar = u.Str("avatar"),
            Uid = u.Str("uid"),
            Email = u.Str("email"),
            Online = u.Bool("online")
        };
    }

    public static async Task<List<UserInfo>> GetFriendsAsync()
    {
        var (ok, _, data, _) = await Get("/api/friends");
        var list = new List<UserInfo>();
        if (!ok || data == null) return list;
        foreach (var f in data.Arr("friends") ?? new JsonArray())
            if (f is JsonObject o) list.Add(ParseUser(o)!);
        return list;
    }

    public static async Task<List<UserInfo>> GetFriendRequestsAsync()
    {
        var (ok, _, data, _) = await Get("/api/friend/requests");
        var list = new List<UserInfo>();
        if (!ok || data == null) return list;
        foreach (var f in data.Arr("requests") ?? new JsonArray())
            if (f is JsonObject o) list.Add(ParseUser(o)!);
        return list;
    }

    public static async Task<List<GroupInfo>> GetGroupsAsync()
    {
        var (ok, _, data, _) = await Get("/api/groups");
        var list = new List<GroupInfo>();
        if (!ok || data == null) return list;
        foreach (var g in data.Arr("groups") ?? new JsonArray())
        {
            if (g is not JsonObject o) continue;
            var group = new GroupInfo
            {
                Id = o.Lng("id"),
                Name = o.Str("name") ?? "",
                OwnerId = o.Lng("ownerId"),
                LastMessage = ParseGroupLastMessage(o.Obj("lastMessage"))
            };
            foreach (var m in o.Arr("members") ?? new JsonArray())
                if (m is JsonObject mo) group.Members.Add(ParseUser(mo)!);
            list.Add(group);
        }
        return list;
    }

    private static MessageItem? ParseGroupLastMessage(JsonObject? lm)
    {
        if (lm == null) return null;
        return new MessageItem
        {
            Id = lm.Lng("id"),
            From = lm.Lng("from"),
            Content = lm.Str("content") ?? "",
            CreatedAt = lm.Lng("createdAt"),
            SenderName = lm.Obj("fromUser")?.Str("nickname") ?? lm.Obj("fromUser")?.Str("username") ?? ""
        };
    }

    public static async Task<List<MessageItem>> GetHistoryAsync(long peerId)
    {
        var (ok, _, data, _) = await Get("/api/history/" + peerId);
        var list = new List<MessageItem>();
        if (!ok || data == null) return list;
        foreach (var m in data.Arr("messages") ?? new JsonArray())
        {
            if (m is not JsonObject o) continue;
            list.Add(new MessageItem
            {
                Id = o.Lng("id"),
                From = o.Lng("from"),
                To = o.Lng("to"),
                Content = o.Str("content") ?? "",
                CreatedAt = o.Lng("createdAt"),
                Read = o.Bool("read")
            });
        }
        return list;
    }

    public static async Task<List<MessageItem>> GetGroupHistoryAsync(long groupId)
    {
        var (ok, _, data, _) = await Get("/api/group/" + groupId + "/messages");
        var list = new List<MessageItem>();
        if (!ok || data == null) return list;
        foreach (var m in data.Arr("messages") ?? new JsonArray())
        {
            if (m is not JsonObject o) continue;
            var fromUser = o.Obj("fromUser");
            list.Add(new MessageItem
            {
                Id = o.Lng("id"),
                From = o.Lng("from"),
                GroupId = groupId,
                Content = o.Str("content") ?? "",
                CreatedAt = o.Lng("createdAt"),
                SenderName = fromUser?.Str("nickname") ?? fromUser?.Str("username") ?? ""
            });
        }
        return list;
    }

    public static async Task<(bool ok, string? error, UserInfo? user)> AddFriendAsync(string uid)
    {
        var (ok, _, data, err) = await Post("/api/friend/add", new { friendUid = uid });
        return (ok, err, data == null ? null : ParseUser(data.Obj("friend")));
    }

    public static async Task<(bool ok, string? error)> AcceptFriendAsync(long friendId)
    {
        var (ok, _, _, err) = await Post("/api/friend/accept", new { friendId });
        return (ok, err);
    }

    public static async Task<(bool ok, string? error)> RejectFriendAsync(long friendId)
    {
        var (ok, _, _, err) = await Post("/api/friend/reject", new { friendId });
        return (ok, err);
    }

    public static async Task<VersionInfo?> GetVersionAsync()
    {
        var (ok, _, data, _) = await Get("/api/version", auth: false);
        if (!ok || data == null) return null;
        return new VersionInfo
        {
            Current = data.Str("current") ?? "0.0.0",
            Latest = data.Str("latest") ?? "0.0.0",
            ReleaseNotes = data.Str("releaseNotes") ?? "",
            Downloads = ParseStrMap(data.Obj("downloads")),
            DownloadVersions = ParseStrMap(data.Obj("downloadVersions"))
        };
    }

    private static Dictionary<string, string> ParseStrMap(JsonObject? o)
    {
        var map = new Dictionary<string, string>();
        if (o == null) return map;
        foreach (var kv in o)
            if (kv.Value != null) map[kv.Key] = kv.Value.GetValue<string>() ?? "";
        return map;
    }
}
