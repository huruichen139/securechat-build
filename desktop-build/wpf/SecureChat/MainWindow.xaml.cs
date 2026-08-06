using System.Collections.ObjectModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;

namespace SecureChat;

public partial class MainWindow : Window
{
    private readonly WsClient _ws = new();
    private readonly ObservableCollection<ConversationItem> _conversations = new();
    private readonly Dictionary<string, ConversationItem> _convByKey = new();
    private readonly Dictionary<long, UserInfo> _usersById = new();
    private readonly Dictionary<long, GroupInfo> _groupsById = new();
    private readonly List<MessageItem> _chatMessages = new();
    private readonly Dictionary<long, string> _peerNameById = new();
    private ConversationItem? _selected;
    private DispatcherTimer _typingTimer;
    private string _typingFrom = "";
    private bool _connected;

    public MainWindow()
    {
        InitializeComponent();
        ConvList.ItemsSource = _conversations;
        Title = "SecureChat" + (string.IsNullOrEmpty(AppState.ServerHost) ? "" : " · " + AppState.ServerHost);

        _ws.OnMessage += OnWsMessage;
        _ws.OnClosed += OnWsClosed;

        _typingTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _typingTimer.Tick += (_, _) =>
        {
            _typingTimer.Stop();
            _typingFrom = "";
            UpdateChatSubtitle();
        };

        Loaded += async (_, _) =>
        {
            RenderMe();
            await LoadInitialAsync();
            _ = _ws.StartAsync(AppState.Token);
            _ = CheckVersionSilentlyAsync();
        };

        Closing += (_, _) => _ws.Dispose();
    }

    private void RenderMe()
    {
        if (AppState.Me == null) return;
        MyName.Text = AppState.Me.DisplayName;
        MyUid.Text = "ID: " + (AppState.Me.Uid ?? "");
        MyInitial.Text = AppState.Me.Initial;
    }

    private async Task LoadInitialAsync()
    {
        try
        {
            var friends = await ApiClient.GetFriendsAsync();
            foreach (var f in friends)
            {
                _usersById[f.Id] = f;
                AddConversation(new ConversationItem
                {
                    Key = "u" + f.Id,
                    PeerId = f.Id,
                    Name = f.DisplayName,
                    Initial = f.Initial,
                    Online = f.Online
                });
            }

            var groups = await ApiClient.GetGroupsAsync();
            foreach (var g in groups)
            {
                _groupsById[g.Id] = g;
                var conv = new ConversationItem
                {
                    Key = "g" + g.Id,
                    GroupId = g.Id,
                    IsGroup = true,
                    Name = g.Name,
                    Initial = g.Name.Length > 0 ? g.Name.Substring(0, 1).ToUpperInvariant() : "群"
                };
                if (g.LastMessage != null)
                {
                    conv.LastPreview = (g.LastMessage.SenderName.Length > 0 ? g.LastMessage.SenderName + ": " : "") + g.LastMessage.Content;
                    conv.LastTime = g.LastMessage.CreatedAt;
                }
                AddConversation(conv);
            }

            var reqs = await ApiClient.GetFriendRequestsAsync();
            Dispatcher.BeginInvoke(() => UpdateRequestsBadge(reqs.Count));

            SortConversations();
        }
        catch (Exception ex)
        {
            ConnStatus.Text = "加载失败：" + ex.Message;
        }
    }

    private void AddConversation(ConversationItem conv)
    {
        if (_convByKey.ContainsKey(conv.Key)) return;
        _convByKey[conv.Key] = conv;
        _conversations.Add(conv);
    }

    private void SortConversations() { }

    private void UpdateRequestsBadge(int count)
    {
        RequestsBtn.Content = count > 0 ? "·" + count : "好友请求";
        RequestsBtn.ToolTip = count > 0 ? "好友请求 (" + count + ")" : "好友请求";
    }

    // ---------- WS ----------

    private void OnWsMessage(string type, JsonObject? payload)
    {
        if (payload == null) return;
        Dispatcher.BeginInvoke(() =>
        {
            try { HandleWsMessage(type, payload); }
            catch (Exception ex) { Debug.WriteLine("WS handle: " + ex); }
        });
    }

    private void HandleWsMessage(string type, JsonObject? p)
    {
        switch (type)
        {
            case "auth_ok":
                _connected = true;
                ConnDot.Fill = new SolidColorBrush(Color.FromRgb(7, 193, 96));
                ConnStatus.Text = "已连接";
                break;

            case "auth_fail":
                _connected = false;
                ConnDot.Fill = new SolidColorBrush(Colors.Red);
                ConnStatus.Text = "登录失效，请重新登录";
                MessageBox.Show(this, "登录已失效，请重新登录。", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Warning);
                _ws.Dispose();
                var login = new LoginWindow();
                login.Show();
                Close();
                break;

            case "msg":
                HandleDirectMessage(p);
                break;

            case "group_msg":
                HandleGroupMessage(p);
                break;

            case "typing":
            {
                var from = p["from"]?.GetValue<long>() ?? 0;
                if (from == AppState.Me?.Id || from == 0) break;
                _typingFrom = "u" + from;
                if (_selected?.Key == _typingFrom)
                {
                    _typingTimer.Stop();
                    _typingTimer.Start();
                    UpdateChatSubtitle();
                }
                break;
            }

            case "user_list":
                foreach (var u in p["users"] as JsonArray ?? new JsonArray())
                {
                    if (u is not JsonObject uo) continue;
                    var id = uo["id"]?.GetValue<long>() ?? 0;
                    var online = uo["online"]?.GetValue<bool>() ?? false;
                    if (_usersById.TryGetValue(id, out var known))
                    {
                        known.Online = online;
                        if (_convByKey.TryGetValue("u" + id, out var conv)) conv.Online = online;
                    }
                }
                break;

            case "friend_list":
            {
                var existing = new HashSet<long>();
                foreach (var u in p["friends"] as JsonArray ?? new JsonArray())
                {
                    if (u is not JsonObject uo) continue;
                    var user = ApiClient.ParseUser(uo)!;
                    _usersById[user.Id] = user;
                    existing.Add(user.Id);
                    if (!_convByKey.ContainsKey("u" + user.Id))
                        AddConversation(new ConversationItem
                        {
                            Key = "u" + user.Id,
                            PeerId = user.Id,
                            Name = user.DisplayName,
                            Initial = user.Initial,
                            Online = user.Online
                        });
                    else if (_convByKey["u" + user.Id] is var conv)
                    {
                        conv.Name = user.DisplayName;
                        conv.Initial = user.Initial;
                    }
                }
                break;
            }

            case "group_list":
            {
                foreach (var g in p["groups"] as JsonArray ?? new JsonArray())
                {
                    if (g is not JsonObject go) continue;
                    var gid = go["id"]?.GetValue<long>() ?? 0;
                    var group = _groupsById.TryGetValue(gid, out var existing) ? existing : new GroupInfo();
                    group.Id = gid;
                    group.Name = go["name"]?.GetValue<string>() ?? group.Name;
                    group.OwnerId = go["ownerId"]?.GetValue<long>() ?? group.OwnerId;
                    _groupsById[gid] = group;
                    if (!_convByKey.ContainsKey("g" + gid))
                        AddConversation(new ConversationItem
                        {
                            Key = "g" + gid,
                            GroupId = gid,
                            IsGroup = true,
                            Name = group.Name,
                            Initial = group.Name.Length > 0 ? group.Name.Substring(0, 1).ToUpperInvariant() : "群"
                        });
                    else
                        _convByKey["g" + gid].Name = group.Name;
                }
                break;
            }

            case "friend_req":
            {
                var fromUser = ApiClient.ParseUser(p.Obj("fromUser"));
                if (fromUser != null)
                {
                    var r = MessageBox.Show(this,
                        fromUser.DisplayName + "（ID: " + fromUser.Uid + "）请求添加你为好友。是否接受？",
                        "好友请求", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
                    if (r == MessageBoxResult.Yes) _ = ApiClient.AcceptFriendAsync(fromUser.Id);
                    else if (r == MessageBoxResult.No) _ = ApiClient.RejectFriendAsync(fromUser.Id);
                }
                break;
            }

            case "signal":
                break;

            case "error":
                ConnStatus.Text = "服务器: " + (p["error"]?.GetValue<string>() ?? "");
                break;
        }
    }

    private void OnWsClosed()
    {
        Dispatcher.BeginInvoke(() =>
        {
            _connected = false;
            ConnDot.Fill = new SolidColorBrush(Color.FromRgb(250, 204, 21));
            ConnStatus.Text = "连接已断开，正在重连…";
        });
    }

    private void HandleDirectMessage(JsonObject p)
    {
        var from = p["from"]?.GetValue<long>() ?? 0;
        var to = p["to"]?.GetValue<long>() ?? 0;
        var msg = new MessageItem
        {
            Id = p["id"]?.GetValue<long>() ?? 0,
            From = from,
            To = to,
            Content = p["content"]?.GetValue<string>() ?? "",
            CreatedAt = p["createdAt"]?.GetValue<long>() ?? 0,
            IsMine = from == AppState.Me?.Id
        };

        if (!_usersById.TryGetValue(from, out var sender))
        {
            sender = _usersById.Values.FirstOrDefault(u => u.Id == from);
            if (sender == null)
            {
                sender = new UserInfo { Id = from, Username = "用户" + from };
                _usersById[from] = sender;
            }
        }

        var peerKey = msg.IsMine ? "u" + to : "u" + from;
        if (!_convByKey.TryGetValue(peerKey, out var conv))
        {
            conv = new ConversationItem
            {
                Key = peerKey,
                PeerId = msg.IsMine ? to : from,
                Name = msg.IsMine ? (_peerNameById.TryGetValue(to, out var n) ? n : "用户" + to) : sender.DisplayName,
                Initial = (msg.IsMine ? _peerNameById.TryGetValue(to, out var ni) ? ni : "?" : sender.DisplayName).Substring(0, 1)
            };
            AddConversation(conv);
        }

        conv.LastPreview = (msg.IsMine ? "我: " : "") + msg.Content;
        conv.LastTime = msg.CreatedAt;

        if (_selected?.Key == peerKey)
        {
            _chatMessages.Add(msg);
            AppendMessage(msg);
            if (!msg.IsMine) _ = MarkReadAsync(from);
        }
        else if (!msg.IsMine)
        {
            conv.Unread++;
            if (_selected == null) UpdateChatSubtitle();
        }
    }

    private void HandleGroupMessage(JsonObject p)
    {
        var gid = p["groupId"]?.GetValue<long>() ?? 0;
        var from = p["from"]?.GetValue<long>() ?? 0;
        var fromUser = p.Obj("fromUser");
        var senderName = fromUser?.Str("nickname") ?? fromUser?.Str("username") ?? "群成员";

        var msg = new MessageItem
        {
            Id = p["id"]?.GetValue<long>() ?? 0,
            From = from,
            GroupId = gid,
            Content = p["content"]?.GetValue<string>() ?? "",
            CreatedAt = p["createdAt"]?.GetValue<long>() ?? 0,
            IsMine = from == AppState.Me?.Id,
            SenderName = senderName
        };

        var key = "g" + gid;
        if (!_convByKey.TryGetValue(key, out var conv))
        {
            conv = new ConversationItem { Key = key, GroupId = gid, IsGroup = true, Name = "群" + gid, Initial = "群" };
            AddConversation(conv);
        }

        conv.LastPreview = (msg.IsMine ? "我: " : senderName + ": ") + msg.Content;
        conv.LastTime = msg.CreatedAt;

        if (_selected?.Key == key)
        {
            _chatMessages.Add(msg);
            AppendMessage(msg);
        }
        else if (!msg.IsMine)
        {
            conv.Unread++;
        }
    }

    // ---------- 消息渲染 ----------

    private void RenderChat()
    {
        MsgList.ItemsSource = null;
        MsgList.ItemsSource = new List<MessageItem>(_chatMessages);
        ScrollToBottom();
    }

    private void AppendMessage(MessageItem msg)
    {
        MsgList.ItemsSource = null;
        MsgList.ItemsSource = new List<MessageItem>(_chatMessages);
        ScrollToBottom();
    }

    private void ScrollToBottom()
    {
        MsgScroll.Dispatcher.BeginInvoke(() => MsgScroll.ScrollToEnd(), DispatcherPriority.Background);
    }

    // ---------- 会话选择 ----------

    private async void ConvList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ConvList.SelectedItem is not ConversationItem conv) return;
        _selected = conv;
        conv.Unread = 0;
        ChatTitle.Text = conv.Name;
        UpdateChatSubtitle();

        _chatMessages.Clear();
        RenderChat();

        if (conv.IsGroup)
        {
            var msgs = await ApiClient.GetGroupHistoryAsync(conv.GroupId);
            foreach (var m in msgs)
            {
                m.IsMine = m.From == AppState.Me?.Id;
                if (!m.IsMine && m.SenderName.Length == 0)
                    m.SenderName = _usersById.TryGetValue(m.From, out var u) ? u.DisplayName : "群成员";
            }
            _chatMessages.AddRange(msgs);
        }
        else
        {
            var msgs = await ApiClient.GetHistoryAsync(conv.PeerId);
            foreach (var m in msgs)
            {
                m.IsMine = m.From == AppState.Me?.Id;
                if (m.From == AppState.Me?.Id && !_peerNameById.ContainsKey(m.To)) _peerNameById[m.To] = conv.Name;
            }
            _chatMessages.AddRange(msgs);
            if (msgs.Any(m => !m.IsMine))
                _ = MarkReadAsync(conv.PeerId);
        }
        RenderChat();
    }

    private async Task MarkReadAsync(long from)
    {
        _ws.Send("read", new JsonObject { ["from"] = from });
        // 也通过 REST 更新已读状态（服务器 WS 已处理，这里仅本地标记）
        var mine = _chatMessages.Where(m => !m.IsMine && m.From == from).ToList();
        foreach (var m in mine) m.Read = true;
        RenderChat();
        await Task.CompletedTask;
    }

    private void UpdateChatSubtitle()
    {
        if (_selected == null)
        {
            ChatSubtitle.Text = "";
            return;
        }
        if (_typingFrom == _selected.Key)
        {
            ChatSubtitle.Text = "对方正在输入…";
            return;
        }
        if (_selected.IsGroup)
        {
            ChatSubtitle.Text = _groupsById.TryGetValue(_selected.GroupId, out var g) ? g.Members.Count + " 名成员" : "群聊";
            return;
        }
        var online = _convByKey.TryGetValue(_selected.Key, out var c) && c.Online;
        ChatSubtitle.Text = online ? "在线" : "离线";
    }

    // ---------- 发送 ----------

    private void Send_Click(object sender, RoutedEventArgs e) => SendCurrent();
    private void InputBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            SendCurrent();
        }
    }

    private void SendCurrent()
    {
        var content = InputBox.Text.Trim();
        if (_selected == null || string.IsNullOrEmpty(content)) return;

        var clientMsgId = "c" + Guid.NewGuid().ToString("N").Substring(0, 20);
        if (_selected.IsGroup)
        {
            _ws.Send("group_msg", new JsonObject
            {
                ["groupId"] = _selected.GroupId,
                ["content"] = content
            });
        }
        else
        {
            _ws.Send("msg", new JsonObject
            {
                ["to"] = _selected.PeerId,
                ["content"] = content,
                ["clientMsgId"] = clientMsgId
            });
        }

        var msg = new MessageItem
        {
            From = AppState.Me?.Id ?? 0,
            To = _selected.IsGroup ? 0 : _selected.PeerId,
            GroupId = _selected.IsGroup ? _selected.GroupId : 0,
            Content = content,
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ClientMsgId = clientMsgId,
            IsMine = true,
            SenderName = _selected.IsGroup ? "我" : ""
        };
        _chatMessages.Add(msg);
        AppendMessage(msg);

        _selected.LastPreview = "我: " + content;
        _selected.LastTime = msg.CreatedAt;

        InputBox.Clear();
        InputBox.Focus();

        if (!_selected.IsGroup)
            _ws.Send("typing", new JsonObject { ["to"] = _selected.PeerId });
    }

    // ---------- 好友 ----------

    private void AddFriend_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new InputDialog("添加好友", "对方 ID（4-16 位字母或数字）:");
        if (dialog.ShowDialog() != true || string.IsNullOrWhiteSpace(dialog.Value)) return;
        _ = AddFriendAsync(dialog.Value.Trim());
    }

    private async Task AddFriendAsync(string uid)
    {
        var (ok, err, user) = await ApiClient.AddFriendAsync(uid);
        if (!ok)
        {
            MessageBox.Show(this, err ?? "添加失败", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        MessageBox.Show(this, "已发送好友请求给 " + user?.DisplayName, "SecureChat", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void Requests_Click(object sender, RoutedEventArgs e)
    {
        var win = new FriendRequestsWindow();
        win.Owner = this;
        win.ShowDialog();
        _ = LoadInitialAsync();
    }

    private void Settings_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new InputDialog("设置服务器", "服务器地址（https://…）:", AppState.ServerHost);
        if (dialog.ShowDialog() == true && !string.IsNullOrWhiteSpace(dialog.Value))
        {
            var host = dialog.Value.Trim().TrimEnd('/');
            if (host != AppState.ServerHost)
            {
                AppState.ServerHost = host;
                ApiClient.ResetClient();
                AppState.Save();
                MessageBox.Show(this, "服务器地址已更新，请重新登录。", "SecureChat", MessageBoxButton.OK, MessageBoxImage.Information);
                Logout();
            }
        }
    }

    private void Logout()
    {
        _ws.Dispose();
        AppState.Token = "";
        AppState.Me = null;
        AppState.Save();
        var login = new LoginWindow();
        login.Show();
        Close();
    }

    // ---------- 更新 ----------

    private async Task CheckVersionSilentlyAsync()
    {
        try
        {
            var info = await ApiClient.GetVersionAsync();
            if (info == null || !UpdateService.IsNewer(AppState.AppVersion, info.Latest)) return;
            Dispatcher.BeginInvoke(() =>
            {
                var r = MessageBox.Show(this,
                    "发现新版本 v" + info.Latest + "\n\n" + (info.ReleaseNotes ?? "") + "\n\n是否立即更新？",
                    "SecureChat 更新", MessageBoxButton.YesNo, MessageBoxImage.Information);
                if (r == MessageBoxResult.Yes) _ = InstallUpdateAsync(info);
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
        var progress = new Progress<double>(p => ConnStatus.Text = $"正在下载更新… {p * 100:F0}%");
        try
        {
            var pkg = await UpdateService.DownloadPackageAsync(url, info.Latest, progress, CancellationToken.None);
            var exe = pkg == null ? null : UpdateService.ExtractToExe(pkg, info.Latest);
            if (exe == null || !File.Exists(exe))
            {
                ConnStatus.Text = "更新包解压失败";
                return;
            }
            UpdateService.MarkLatest(info.Latest);
            UpdateService.LaunchAndExit(exe);
            Application.Current.Shutdown();
        }
        catch (Exception ex)
        {
            ConnStatus.Text = "更新失败：" + ex.Message;
        }
    }
}
