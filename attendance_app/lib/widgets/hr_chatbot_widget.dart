// ============================================================
// hr_chatbot_widget.dart  →  lib/widgets/hr_chatbot_widget.dart
// ============================================================
//
// Server-scoped rewrite. Previously this widget:
//   1. Called api.anthropic.com directly with a hardcoded API key that
//      shipped inside the compiled APK.
//   2. Was fed an HREmployeeData object built ad-hoc by whichever screen
//      instantiated it (office_home_screen.dart / field_home_screen.dart)
//      -- most fields (salary, leave usage, overtime pay, ...) silently
//      defaulted to 0/placeholder because nobody wired them up.
//
// Now: this widget only needs `user` (already carries the bearer token
// every other screen uses). ApiService.sendHrAssistantMessage hits a
// server-side route that resolves org_id/branch_id/staff_id from that
// token and assembles the employee's REAL salary/attendance/leave/
// overtime snapshot before ever calling the model -- see
// client_staff_hr_assistant_routes.py / support_db_hr_assistant.py.
//
// The "Performance" quick action has been removed: no performance-rating
// data exists anywhere in the backend, so it was always a fake 'Good'
// placeholder.

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kDebugMode;
import '../models/user_model.dart';
import '../services/api_service.dart';

// ── Chat Message Model ────────────────────────────────────────
class _ChatMsg {
  final bool isUser;
  final String text;
  final List<List<String>>? infoCard;

  _ChatMsg({required this.isUser, required this.text, this.infoCard});
}

// ── Quick Action ──────────────────────────────────────────────
class _QuickAction {
  final String icon;
  final String label;
  final String query;
  const _QuickAction(this.icon, this.label, this.query);
}

const _quickActions = [
  _QuickAction('💰', 'Salary', 'میری salary breakdown بتاؤ'),
  _QuickAction('🌿', 'Leave', 'میری leave usage کیا ہے؟'),
  _QuickAction('📅', 'Attendance', 'Is mahine meri attendance kaisi hai?'),
  _QuickAction('⏱️', 'Overtime', 'میرا overtime status کیا ہے؟'),
  _QuickAction('🔔', 'Salary?', 'Salary kab credit hogi?'),
];

// ── Colors ────────────────────────────────────────────────────
const _bg = Color(0xFF0F0A1E);
const _surface = Color(0xFF140D2B);
const _purple = Color(0xFF7C3AED);
const _purpleDk = Color(0xFF6D28D9);
const _purpleLt = Color(0xFFA78BFA);
const _border = Color(0x4D8B5CF6);
const _text = Color(0xFFE2E8F0);
const _muted = Color(0xFF6B7280);

// ── Main Widget ───────────────────────────────────────────────
class HRChatbotWidget extends StatefulWidget {
  final UserModel user;
  const HRChatbotWidget({super.key, required this.user});

  @override
  State<HRChatbotWidget> createState() => _HRChatbotWidgetState();
}

class _HRChatbotWidgetState extends State<HRChatbotWidget>
    with TickerProviderStateMixin {
  bool _open = false;
  bool _loading = false;
  bool _notif = true;
  int _unread = 0;
  final _inputCtrl = TextEditingController();
  final _scrollCtrl = ScrollController();

  late AnimationController _fabAnim;
  late AnimationController _windowAnim;
  late Animation<double> _windowScale;

  final List<_ChatMsg> _msgs = [];

  @override
  void initState() {
    super.initState();
    _msgs.add(_ChatMsg(
      isUser: false,
      text: 'Assalam-o-Alaikum ${widget.user.name}! 👋\n'
          'I am your HR Assistant.\n'
          'Salary, Leave, Attendance or Overtime — Ask anything!\n\n'
          'دونوں میں بات کر سکتے ہیں Urdu یا English آپ',
    ));
    _fabAnim = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 1500))
      ..repeat(reverse: true);
    _windowAnim = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 220));
    _windowScale = CurvedAnimation(parent: _windowAnim, curve: Curves.easeOut);
  }

  @override
  void dispose() {
    _fabAnim.dispose();
    _windowAnim.dispose();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _openChat() {
    setState(() {
      _open = true;
      _unread = 0;
    });
    _windowAnim.forward();
  }

  void _closeChat() {
    _windowAnim.reverse().then((_) => setState(() => _open = false));
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtrl.hasClients) {
        _scrollCtrl.animateTo(
          _scrollCtrl.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  /// Parses the server's info_card (List<[label, value]>) into the shape
  /// _buildInfoCard expects. Server-authoritative now -- see
  /// hr_assistant_service._build_info_card -- this is display-only
  /// parsing, no business logic left on the client.
  List<List<String>>? _parseInfoCard(dynamic raw) {
    if (raw is! List) return null;
    final rows = <List<String>>[];
    for (final entry in raw) {
      if (entry is List && entry.length >= 2) {
        rows.add([entry[0].toString(), entry[1].toString()]);
      }
    }
    return rows.isEmpty ? null : rows;
  }

  // ── Send Message ────────────────────────────────────────────
  Future<void> _send(String text) async {
    if (text.trim().isEmpty || _loading) return;
    _inputCtrl.clear();

    setState(() {
      _msgs.add(_ChatMsg(isUser: true, text: text));
      _loading = true;
    });
    _scrollToBottom();

    try {
      final data =
          await ApiService.sendHrAssistantMessage(widget.user.token, text);
      final reply = (data['reply'] as String?)?.trim();
      final card = _parseInfoCard(data['info_card']);
      setState(() {
        _msgs.add(_ChatMsg(
          isUser: false,
          text: (reply == null || reply.isEmpty)
              ? 'Sorry, I could not understand that.'
              : reply,
          infoCard: card,
        ));
        _loading = false;
        if (!_open) _unread++;
      });
    } catch (e) {
      // Surface the real cause instead of a generic message -- a timeout,
      // a 4xx/5xx from the server, and an actual offline device all need
      // different fixes, and a blanket "check your internet" message
      // sends users chasing the wrong problem (and hid the ImportError-
      // turned-405 bug from us during earlier debugging).
      final msg = kDebugMode ? '❌ $e' : '❌ Something went wrong. Please try again.';
      setState(() {
        _msgs.add(_ChatMsg(isUser: false, text: msg));
        _loading = false;
      });
    }
    _scrollToBottom();
  }

  // ── Build ───────────────────────────────────────────────────
  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      if (_open)
        Positioned(
          bottom: 90,
          right: 16,
          child: ScaleTransition(
            scale: _windowScale,
            alignment: Alignment.bottomRight,
            child: _buildWindow(),
          ),
        ),
      Positioned(
        bottom: 24,
        right: 20,
        child: _buildFab(),
      ),
    ]);
  }

  // ── FAB ─────────────────────────────────────────────────────
  Widget _buildFab() {
    return AnimatedBuilder(
      animation: _fabAnim,
      builder: (_, child) => Transform.scale(
        scale: 1.0 + _fabAnim.value * 0.06,
        child: child,
      ),
      child: GestureDetector(
        onTap: _open ? _closeChat : _openChat,
        child: Container(
          width: 54,
          height: 54,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              colors: [_purple, _purpleDk],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                  color: _purple.withValues(alpha: 0.5),
                  blurRadius: 16,
                  spreadRadius: 1)
            ],
          ),
          child: Stack(alignment: Alignment.center, children: [
            Text(_open ? '✕' : '🤖',
                style: TextStyle(fontSize: _open ? 18 : 22)),
            if (_unread > 0 && !_open)
              Positioned(
                top: 6,
                right: 6,
                child: Container(
                  width: 17,
                  height: 17,
                  decoration: const BoxDecoration(
                      color: Color(0xFFEF4444), shape: BoxShape.circle),
                  child: Center(
                    child: Text('$_unread',
                        style: const TextStyle(
                            color: Colors.white,
                            fontSize: 9,
                            fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
          ]),
        ),
      ),
    );
  }

  // ── Chat Window ─────────────────────────────────────────────
  Widget _buildWindow() {
    return Container(
      width: 320,
      height: 490,
      decoration: BoxDecoration(
        color: _bg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: _border),
        boxShadow: [
          BoxShadow(
              color: Colors.black.withValues(alpha: 0.6),
              blurRadius: 30,
              spreadRadius: 2)
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Column(children: [
          _buildHeader(),
          _buildQuickButtons(),
          Expanded(child: _buildMessages()),
          _buildInput(),
        ]),
      ),
    );
  }

  // ── Header ──────────────────────────────────────────────────
  Widget _buildHeader() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: const BoxDecoration(
        gradient: LinearGradient(colors: [Color(0xFF4C1D95), _purpleDk]),
      ),
      child: Row(children: [
        Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.15),
            shape: BoxShape.circle,
          ),
          child:
              const Center(child: Text('🤖', style: TextStyle(fontSize: 16))),
        ),
        const SizedBox(width: 9),
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('HR Assistant',
              style: TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w600)),
          Text('${widget.user.name} • ${widget.user.department}',
              style: TextStyle(
                  color: Colors.white.withValues(alpha: 0.65), fontSize: 11)),
        ])),
        GestureDetector(
          onTap: () => setState(() => _notif = !_notif),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
            decoration: BoxDecoration(
              color: _notif
                  ? const Color(0x30FACC15)
                  : Colors.white.withValues(alpha: 0.08),
              borderRadius: BorderRadius.circular(7),
              border: Border.all(
                  color: _notif
                      ? const Color(0x59FACC15)
                      : Colors.white.withValues(alpha: 0.15)),
            ),
            child: Text(_notif ? '🔔' : '🔕',
                style: const TextStyle(fontSize: 13)),
          ),
        ),
        const SizedBox(width: 6),
        GestureDetector(
          onTap: _closeChat,
          child: Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(7),
            ),
            child: const Icon(Icons.close, color: Colors.white, size: 14),
          ),
        ),
      ]),
    );
  }

  // ── Quick Buttons ────────────────────────────────────────────
  Widget _buildQuickButtons() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      color: _surface,
      child: Wrap(
        spacing: 5,
        runSpacing: 5,
        children: _quickActions
            .map((a) => GestureDetector(
                  onTap: () => _send(a.query),
                  child: Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                    decoration: BoxDecoration(
                      color: _purple.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: _border),
                    ),
                    child: Text('${a.icon} ${a.label}',
                        style: const TextStyle(fontSize: 11, color: _purpleLt)),
                  ),
                ))
            .toList(),
      ),
    );
  }

  // ── Messages ─────────────────────────────────────────────────
  Widget _buildMessages() {
    return ListView.builder(
      controller: _scrollCtrl,
      padding: const EdgeInsets.all(10),
      itemCount: _msgs.length + (_loading ? 1 : 0),
      itemBuilder: (_, i) {
        if (i == _msgs.length) return _buildTyping();
        return _buildMsgItem(_msgs[i]);
      },
    );
  }

  Widget _buildMsgItem(_ChatMsg msg) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        mainAxisAlignment:
            msg.isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!msg.isUser) ...[
            _avatar('🤖', false),
            const SizedBox(width: 6),
          ],
          Flexible(
              child: Column(
            crossAxisAlignment:
                msg.isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                decoration: BoxDecoration(
                  color: msg.isUser
                      ? _purpleDk
                      : Colors.white.withValues(alpha: 0.05),
                  border: msg.isUser
                      ? null
                      : Border.all(color: _border.withValues(alpha: 0.5)),
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(14),
                    topRight: const Radius.circular(14),
                    bottomLeft: Radius.circular(msg.isUser ? 14 : 4),
                    bottomRight: Radius.circular(msg.isUser ? 4 : 14),
                  ),
                ),
                child: Text(msg.text,
                    style: const TextStyle(
                        color: _text, fontSize: 13, height: 1.6)),
              ),
              if (msg.infoCard != null) ...[
                const SizedBox(height: 5),
                _buildInfoCard(msg.infoCard!),
              ],
            ],
          )),
          if (msg.isUser) ...[
            const SizedBox(width: 6),
            _avatar('👤', true),
          ],
        ],
      ),
    );
  }

  Widget _avatar(String emoji, bool isUser) => Container(
        width: 26,
        height: 26,
        decoration: BoxDecoration(
          color: isUser ? _purpleDk : _purple.withValues(alpha: 0.2),
          shape: BoxShape.circle,
        ),
        child: Center(child: Text(emoji, style: const TextStyle(fontSize: 12))),
      );

  Widget _buildInfoCard(List<List<String>> rows) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: _purple.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _border),
      ),
      child: Column(
          children: rows.asMap().entries.map((e) {
        final isLast = e.key == rows.length - 1;
        return Column(children: [
          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text(e.value[0],
                style: const TextStyle(color: _purpleLt, fontSize: 12)),
            Text(e.value[1],
                style: const TextStyle(
                    color: _text, fontSize: 12, fontWeight: FontWeight.w500)),
          ]),
          if (!isLast)
            Divider(color: _border.withValues(alpha: 0.5), height: 8),
        ]);
      }).toList()),
    );
  }

  Widget _buildTyping() {
    return Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
      _avatar('🤖', false),
      const SizedBox(width: 6),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.05),
          border: Border.all(color: _border.withValues(alpha: 0.5)),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(14),
            topRight: Radius.circular(14),
            bottomLeft: Radius.circular(4),
            bottomRight: Radius.circular(14),
          ),
        ),
        child: const _TypingDots(),
      ),
    ]);
  }

  // ── Input ────────────────────────────────────────────────────
  Widget _buildInput() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
      decoration: BoxDecoration(
        color: _bg,
        border: Border(top: BorderSide(color: _border.withValues(alpha: 0.5))),
      ),
      child: Row(children: [
        Expanded(
          child: TextField(
            controller: _inputCtrl,
            style: const TextStyle(color: _text, fontSize: 13),
            onSubmitted: _send,
            decoration: InputDecoration(
              hintText: 'Urdu ya English mein poochein...',
              hintStyle: const TextStyle(color: _muted, fontSize: 12),
              contentPadding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              filled: true,
              fillColor: Colors.white.withValues(alpha: 0.06),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: const BorderSide(color: _border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: const BorderSide(color: _border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(20),
                borderSide: const BorderSide(color: _purple),
              ),
            ),
          ),
        ),
        const SizedBox(width: 7),
        GestureDetector(
          onTap: () => _send(_inputCtrl.text),
          child: Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: _purple,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(color: _purple.withValues(alpha: 0.4), blurRadius: 8)
              ],
            ),
            child:
                const Icon(Icons.send_rounded, color: Colors.white, size: 16),
          ),
        ),
      ]),
    );
  }
}

// ── Typing Dots Animation ─────────────────────────────────────
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with TickerProviderStateMixin {
  late List<AnimationController> _ctrls;
  late List<Animation<double>> _anims;

  @override
  void initState() {
    super.initState();
    _ctrls = List.generate(
        3,
        (i) => AnimationController(
              vsync: this,
              duration: const Duration(milliseconds: 600),
            )..repeat(
                reverse: true, period: Duration(milliseconds: 600 + i * 200)));
    _anims =
        _ctrls.map((c) => Tween(begin: 0.0, end: -5.0).animate(c)).toList();
  }

  @override
  void dispose() {
    for (var c in _ctrls) c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: List.generate(
            3,
            (i) => AnimatedBuilder(
                  animation: _anims[i],
                  builder: (_, __) => Transform.translate(
                    offset: Offset(0, _anims[i].value),
                    child: Container(
                      width: 6,
                      height: 6,
                      margin: const EdgeInsets.symmetric(horizontal: 2),
                      decoration: const BoxDecoration(
                          color: Color(0xFFA78BFA), shape: BoxShape.circle),
                    ),
                  ),
                )),
      );
}