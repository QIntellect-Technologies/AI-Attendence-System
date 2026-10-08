import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:image/image.dart' as img;
import 'dart:convert';
import '../../models/user_model.dart';
import '../../utils/app_theme.dart';
import '../../services/api_service.dart';
import '../../services/offline_queue_service.dart';

/// Active-liveness face verification.
///
/// ── Why this captures a burst instead of one still ─────────────────────
/// The previous version posted a single frame and the server tried to
/// tell a live face from a photo using an FFT texture score. That metric
/// measures sharpness, not liveness, and on matched content it ranks the
/// attacks ABOVE the genuine samples (printed photo 2.37, screen replay
/// 2.12, live face in good light 2.04, live face motion-blurred 0.20) --
/// a print is sharpened by the print-and-recapture cycle and a screen
/// adds its own pixel-grid energy, while a real face indoors is dim and
/// slightly blurred. No threshold separates them, which is why enabling
/// that check locked staff out and disabling it let photos through.
///
/// Movement is a signal a flat artifact cannot fake. The server picks a
/// direction, the employee performs it, and the server checks the head
/// actually travelled that way and came back to centre. See
/// shared_face_engine/liveness.py.
///
/// ── Order of operations matters ────────────────────────────────────────
/// Fetch the challenge FIRST, then capture. Never cache a challenge or
/// reuse a token: the replay defence is that the client cannot predict or
/// pick which motion will be demanded. Tokens are single-use server-side,
/// so a retry must start over from the top of _verify.
class FaceVerificationScreen extends StatefulWidget {
  final UserModel user;
  const FaceVerificationScreen({super.key, required this.user});

  @override
  State<FaceVerificationScreen> createState() => _FaceVerificationScreenState();
}

class _FaceVerificationScreenState extends State<FaceVerificationScreen> {
  CameraController? _controller;
  List<CameraDescription>? _cameras;
  bool _isFrontCamera = false;
  bool _initialized = false;
  bool _verifying = false;
  String _status = 'Camera is initializing...';
  String _prompt = '';
  String _error = '';

  // 5 frames over ~2.4s gives liveness.verify_challenge a trajectory with
  // both a peak excursion AND a near-frontal frame, which is exactly what
  // separates a real turn from a photo held at an angle. Keep the total
  // comfortably inside the server's 120s challenge TTL, leaving room for
  // upload on a slow field connection.
  static const int _burstFrames = 5;
  static const Duration _burstGap = Duration(milliseconds: 600);

  @override
  void initState() {
    super.initState();
    _initCamera();
  }

  Future<void> _initCamera() async {
    try {
      _cameras = await availableCameras();
      if (_cameras == null || _cameras!.isEmpty) {
        setState(() => _error = 'No camera found.');
        return;
      }

      // Prefer front camera
      final frontCam = _cameras!.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => _cameras!.first,
      );
      _isFrontCamera = frontCam.lensDirection == CameraLensDirection.front;

      _controller = CameraController(
        frontCam,
        ResolutionPreset.medium,
        enableAudio: false,
      );

      await _controller!.initialize();

      if (mounted) {
        setState(() {
          _initialized = true;
          _status = 'Hold your phone at eye level, then tap Verify.';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = 'Camera error: ${e.toString()}');
    }
  }

  /// Un-mirror a front-camera capture and bake EXIF orientation into
  /// pixel order.
  ///
  /// This is the most fragile point in the whole liveness flow. The
  /// server derives head direction from pixel geometry -- where the nose
  /// sits relative to the eye midpoint -- so a horizontally flipped burst
  /// turns "left" into "right" and fails a perfectly genuine employee,
  /// every time, on whichever devices happen to mirror. Whether
  /// takePicture() returns a mirrored image on the front lens varies by
  /// platform, OEM and plugin version, so leaving it to the default is a
  /// coin flip that lands differently across a fleet.
  ///
  /// bakeOrientation matters for the same reason: without it a phone held
  /// in another orientation hands the server a sideways image in which
  /// the yaw axis runs vertically, and the nose offset stops meaning
  /// anything.
  ///
  /// Doing this on-device is safe even though nothing else about the
  /// liveness verdict is trusted to the device: flipping an image cannot
  /// manufacture head motion that never happened. An attacker who tampers
  /// here still has to produce a real excursion in the yaw series, and
  /// the excursion is what is measured. Contrast the match verdict
  /// itself, which must never become a client claim.
  Future<String> _normaliseForUpload(XFile shot) async {
    final bytes = await File(shot.path).readAsBytes();
    final decoded = img.decodeImage(bytes);
    if (decoded == null) {
      // Undecodable locally: send the original rather than dropping the
      // frame. The server simply won't find a face in it and counts it as
      // an unusable frame, which is the correct outcome.
      return base64Encode(bytes);
    }

    var oriented = img.bakeOrientation(decoded);
    if (_isFrontCamera) {
      oriented = img.flipHorizontal(oriented);
    }
    // Re-encode at moderate quality: five frames travel in one request,
    // and ArcFace gains nothing from a larger JPEG than this.
    return base64Encode(img.encodeJpg(oriented, quality: 85));
  }

  Future<void> _verify() async {
    if (_controller == null || !_controller!.value.isInitialized) return;

    setState(() {
      _verifying = true;
      _error = '';
      _status = 'Preparing...';
    });

    try {
      // ── Step 1: server picks the challenge ──────────────────────────
      // Fetched fresh on every attempt, before any capture. See class doc.
      Map<String, dynamic> challenge;
      try {
        challenge = await ApiService.getLivenessChallenge(widget.user.token);
      } catch (e) {
        if (!OfflineQueueService.looksOffline(e)) rethrow;
        await _handleOffline();
        return;
      }

      final challengeToken = challenge['challenge_token'] as String?;
      if (challengeToken == null) {
        setState(() {
          _verifying = false;
          _status = 'Could not start verification. Please try again.';
        });
        return;
      }

      if (!mounted) return;
      setState(() {
        _prompt = (challenge['prompt'] as String?) ??
            'Slowly turn your head, then back to centre.';
        _status = 'Get ready...';
      });

      // A beat for the employee to read the prompt before capture starts.
      // Without it the first frames are taken while they are still
      // reading, and the burst misses the movement entirely.
      await Future.delayed(const Duration(milliseconds: 1200));

      // ── Step 2: capture the burst ───────────────────────────────────
      final List<String> frames = [];
      for (var i = 0; i < _burstFrames; i++) {
        if (!mounted) return;
        setState(() => _status = 'Keep going... ${i + 1}/$_burstFrames');
        final XFile shot = await _controller!.takePicture();
        frames.add(await _normaliseForUpload(shot));
        // Best-effort cleanup of the plugin's temp file: a leftover costs
        // disk space, not correctness.
        try {
          await File(shot.path).delete();
        } catch (_) {}
        if (i < _burstFrames - 1) await Future.delayed(_burstGap);
      }

      if (!mounted) return;
      setState(() => _status = 'Verifying with server...');

      // ── Step 3: one request carrying the whole burst ────────────────
      Map<String, dynamic> data;
      try {
        data = await ApiService.verifyFaceBurst(
            widget.user.token, widget.user.id, frames, challengeToken);
      } catch (e) {
        if (!OfflineQueueService.looksOffline(e)) rethrow;
        await _handleOffline();
        return;
      }

      if (!mounted) return;

      // `verified` is the ONLY field carrying the match decision. Do not
      // OR in `success`.
      //
      // The backend wraps every 200 through client_routes_helpers.ok(),
      // which is literally {"success": True, **data} -- so `success` is
      // true on every non-error response, including every rejection
      // branch: no face detected, liveness failed, not enrolled, and a
      // genuine below-threshold non-match. Reading it here made this
      // expression a constant, which silently discarded the server's real
      // verdict and reported every attempt as a pass -- including
      // attempts with a colleague's face, and with no face at all.
      //
      // A real transport failure never reaches this line: ApiService
      // throws on non-2xx, and the offline case returned above.
      final verified = data['verified'] == true;
      final similarity = (data['similarity'] as num?)?.toDouble();

      if (verified) {
        setState(() => _status = 'Face verified successfully!');
        await Future.delayed(const Duration(milliseconds: 800));
        if (mounted) {
          Navigator.pop(context, {'verified': true, 'similarity': similarity});
        }
      } else {
        setState(() {
          _verifying = false;
          _prompt = '';
          // Surface the SERVER's message rather than a hardcoded "Face
          // does not match". The server distinguishes a failed liveness
          // check from a failed identity match from an unenrolled staff
          // member, and showing "does not match" for all three sends
          // people off to re-enroll when they only needed to turn their
          // head.
          _status =
              (data['message'] as String?) ?? 'Verification failed. Try again.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _verifying = false;
          _prompt = '';
          _status = 'An error occurred. Please try again.';
          _error = e.toString();
        });
      }
    }
  }

  /// Connectivity failure, not a server rejection -- the biometric check
  /// is never skipped, only deferred.
  ///
  /// Only a single still is stored. Liveness cannot be run retroactively:
  /// a challenge is a live interaction, and by sync time there is nobody
  /// there to turn their head. The server's deferred path therefore
  /// returns liveness_checked=false, and the mark is flagged for admin
  /// review rather than treated as equivalent to a live verification.
  ///
  /// The JPEG goes to path_provider's documents directory, NOT into the
  /// offline queue's SharedPreferences blob -- that blob holds every
  /// pending action for this user as one JSON string and would bloat
  /// badly with image bytes stuffed inside it.
  Future<void> _handleOffline() async {
    if (!mounted) return;
    setState(() => _status = 'Offline — saving photo to verify later...');

    final XFile shot = await _controller!.takePicture();
    final dir = await getApplicationDocumentsDirectory();
    final savedPath =
        '${dir.path}/pending_face_${DateTime.now().microsecondsSinceEpoch}.jpg';
    await File(shot.path).copy(savedPath);

    if (!mounted) return;
    Navigator.pop(context, {
      'verified': false,
      'offline_captured': true,
      'photo_path': savedPath,
    });
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.bg,
      appBar: AppBar(
        title: const Text('Face Verification'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.pop(context, {'verified': false}),
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: _error.isNotEmpty && !_initialized
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.camera_alt,
                            color: Colors.grey, size: 64),
                        const SizedBox(height: 16),
                        Text(_error,
                            style: const TextStyle(color: Colors.grey),
                            textAlign: TextAlign.center),
                      ],
                    ),
                  )
                : _initialized
                    ? ClipRRect(
                        borderRadius: const BorderRadius.vertical(
                            bottom: Radius.circular(24)),
                        child: CameraPreview(_controller!),
                      )
                    : const Center(
                        child: CircularProgressIndicator(
                            color: AppTheme.primary)),
          ),

          Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              children: [
                // The prompt is the loudest thing on screen while
                // capturing. If the employee misses it they simply won't
                // move, the yaw series stays flat, and the server
                // correctly rejects a genuine person.
                if (_prompt.isNotEmpty)
                  Container(
                    width: double.infinity,
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 16, vertical: 14),
                    decoration: BoxDecoration(
                      color: AppTheme.primary.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                          color: AppTheme.primary.withValues(alpha: 0.6)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.threesixty,
                            color: AppTheme.primary, size: 28),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            _prompt,
                            style: const TextStyle(
                                color: Colors.white,
                                fontSize: 16,
                                fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                  ),

                if (_initialized && !_verifying && _prompt.isEmpty)
                  Container(
                    width: 120,
                    height: 120,
                    margin: const EdgeInsets.only(bottom: 16),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                          color: AppTheme.primary.withValues(alpha: 0.6),
                          width: 3),
                    ),
                    child: const Icon(Icons.face,
                        color: AppTheme.primary, size: 60),
                  ),

                Text(
                  _status,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 14),
                ),

                if (_error.isNotEmpty && _initialized) ...[
                  const SizedBox(height: 6),
                  Text(_error,
                      textAlign: TextAlign.center,
                      style:
                          const TextStyle(color: Colors.orange, fontSize: 12)),
                ],

                const SizedBox(height: 20),

                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton.icon(
                    onPressed: _initialized && !_verifying ? _verify : null,
                    icon: _verifying
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                                color: Colors.white, strokeWidth: 2),
                          )
                        : const Icon(Icons.camera),
                    label: Text(_verifying ? 'Verifying...' : 'Verify Face'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}