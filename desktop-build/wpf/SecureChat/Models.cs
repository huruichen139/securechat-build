namespace SecureChat;

using System.Windows;
using System.Windows.Media;
using System.Windows.Controls;

public class UserInfo
{
    public long Id { get; set; }
    public string? Username { get; set; }
    public string? Nickname { get; set; }
    public string? Avatar { get; set; }
    public string? Uid { get; set; }
    public string? Email { get; set; }
    public bool Online { get; set; }

    public string DisplayName => string.IsNullOrWhiteSpace(Nickname) ? (Username ?? "用户") : Nickname!;
    public string Initial => DisplayName.Length > 0 ? DisplayName.Substring(0, 1).ToUpperInvariant() : "?";
}

public class MessageItem
{
    public long Id { get; set; }
    public long From { get; set; }
    public long To { get; set; }
    public long GroupId { get; set; }
    public string Content { get; set; } = "";
    public long CreatedAt { get; set; }
    public string? ClientMsgId { get; set; }
    public bool Read { get; set; }
    public bool IsMine { get; set; }
    public string SenderName { get; set; } = "";

    public DateTime Time => DateTimeOffset.FromUnixTimeMilliseconds(CreatedAt).LocalDateTime;
    public string TimeText => Time.ToString("HH:mm");
    public HorizontalAlignment Align => IsMine ? HorizontalAlignment.Right : HorizontalAlignment.Left;
    public Brush BubbleBg => IsMine
        ? (Brush)Application.Current.Resources["BubbleMine"]
        : (Brush)Application.Current.Resources["BubbleOther"];
    public bool ShowSender => !IsMine && !string.IsNullOrEmpty(SenderName);
    public Visibility ReadBadgeVisibility => IsMine && Read ? Visibility.Visible : Visibility.Collapsed;
}

public class GroupInfo
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public long OwnerId { get; set; }
    public List<UserInfo> Members { get; set; } = new();
    public MessageItem? LastMessage { get; set; }
}

public class ConversationItem
{
    public string Key { get; set; } = "";
    public long PeerId { get; set; }
    public long GroupId { get; set; }
    public bool IsGroup { get; set; }
    public string Name { get; set; } = "";
    public string Initial { get; set; } = "?";
    public bool Online { get; set; }
    public string LastPreview { get; set; } = "";
    public long LastTime { get; set; }
    public int Unread { get; set; }
    public bool HasUnread => Unread > 0;
    public string TimeText
    {
        get
        {
            if (LastTime <= 0) return "";
            var t = DateTimeOffset.FromUnixTimeMilliseconds(LastTime).LocalDateTime;
            if (t.Date == DateTime.Today) return t.ToString("HH:mm");
            if (t.Date == DateTime.Today.AddDays(-1)) return "昨天";
            return t.ToString("MM-dd");
        }
    }
}

public class FriendRequestItem
{
    public UserInfo User { get; set; } = new();
}

public class VersionInfo
{
    public string Current { get; set; } = "0.0.0";
    public string Latest { get; set; } = "0.0.0";
    public string ReleaseNotes { get; set; } = "";
    public Dictionary<string, string> Downloads { get; set; } = new();
    public Dictionary<string, string> DownloadVersions { get; set; } = new();
}

public class LoginResult
{
    public string? Token { get; set; }
    public UserInfo? User { get; set; }
    public string? Error { get; set; }
}
