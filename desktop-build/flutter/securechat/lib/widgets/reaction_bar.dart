import 'package:flutter/material.dart';
import '../services/securechat_api.dart';
import '../services/app_config.dart';

class ReactionBar extends StatelessWidget {
  final Map<String, dynamic> msg;
  final SecureChatApi api;
  final AppConfig config;

  const ReactionBar({super.key, required this.msg, required this.api, required this.config});

  static const _emojiChars = ['\u{1F60A}', '\u{1F621}', '\u{1F632}', '\u{1F622}', '\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F525}', '\u{1F44D}', '\u{2B50}'];
  static const _emojiLabels = ['微笑', '生气', '惊讶', '难过', '点赞', '爱心', '哈哈', '火焰', '强', '星星'];

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: List.generate(_emojiChars.length, (i) {
          return GestureDetector(
            onTap: () async {
              Navigator.pop(context);
              await api.toggleReaction(msg['id'] as int, _emojiChars[i]);
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_emojiChars[i], style: const TextStyle(fontSize: 24)),
                const SizedBox(height: 2),
                Text(_emojiLabels[i], style: TextStyle(fontSize: 9, color: config.theme.subText)),
              ],
            ),
          );
        }),
      ),
    );
  }
}
