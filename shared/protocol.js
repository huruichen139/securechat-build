'use strict';
// 协议消息类型与版本，保证前后端一致
module.exports = {
  VERSION: 1,
  // 客户端 -> 服务端
  C_AUTH: 'auth',          // 登录鉴权
  C_MSG: 'msg',            // 发送聊天消息
  C_READ: 'read',          // 标记已读
  C_TYPING: 'typing',     // 正在输入
  C_LOGOUT: 'logout',
  // 信令：客户端 <-> 客户端，服务端只转发
  C_SIGNAL: 'signal',      // 统一信令通道，payload: {to, sub, data}
  //   sub 可为：call / call_ack / offer / answer / ice / hangup / file_offer / file_ack / file_cancel
  // 服务端 -> 客户端
  S_AUTH_OK: 'auth_ok',
  S_AUTH_FAIL: 'auth_fail',
  S_MSG: 'msg',            // 推送新消息
  S_MSG_RECALL: 'msg_recall', // 推送消息撤回通知 payload {messageId, from, to}
  S_MSG_EDIT: 'msg_edit', // 推送消息编辑通知 payload {messageId, from, to, content}
  S_MSG_READ: 'msg_read', // 推送对方已读 payload {peerId}
  S_GROUP_MSG_READ: 'group_msg_read', // 推送群已读 payload {groupId, userId}
  S_PRESENCE: 'presence',  // 在线状态
  S_TYPING: 'typing',
  S_ERROR: 'error',
  S_HISTORY: 'history',    // 历史消息
  S_USER_LIST: 'user_list',
  S_SIGNAL: 'signal',      // 转发的信令，payload: {from, sub, data}
  // 好友相关（服务端 -> 客户端实时推送）
  S_FRIEND_REQ: 'friend_req',   // 收到好友请求 payload {from, fromUser}
  S_FRIEND_LIST: 'friend_list', // 好友列表更新 payload {friends}
  // 群组相关
  C_GROUP_MSG: 'group_msg',     // 客户端 -> 服务端 payload {groupId, content}
  C_GROUP_READ: 'group_read',   // 客户端 -> 服务端 payload {groupId}（标记已读）
  S_GROUP_MSG: 'group_msg',     // 服务端 -> 客户端 payload {groupId, from, fromUid, content, createdAt}
  S_GROUP_LIST: 'group_list',   // 服务端 -> 客户端 payload {groups:[...]}
  S_GROUP_MEMBER_CHANGE: 'group_member_change', // 服务端 -> 客户端 payload {groupId, userId, action: 'removed'|'left'|'dissolved'}
  // 系统公告（管理员广播）
  S_ANNOUNCEMENT: 'announcement',   // 服务端 -> 客户端 payload {announcement}
  C_ANNOUNCEMENT_READ: 'announcement_read', // 客户端 -> 服务端 payload {id} 标记公告已读
  // 强制下线
  S_KICKED: 'kicked',
};

