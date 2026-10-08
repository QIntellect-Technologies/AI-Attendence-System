import 'package:flutter/material.dart';
import '../utils/app_theme.dart';

class CustomCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets? padding;
  const CustomCard({super.key, required this.child, this.padding});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: padding ?? const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppTheme.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white.withOpacity(0.05)),
      ),
      child: child,
    );
  }
}

class StatusBadge extends StatelessWidget {
  final String status;
  const StatusBadge({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    Color color;
    switch (status.toLowerCase()) {
      case 'approved': color = AppTheme.success; break;
      case 'pending': color = AppTheme.warning; break;
      case 'rejected': color = AppTheme.error; break;
      default: color = Colors.grey;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.15),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(status,
          style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class LoadingButton extends StatelessWidget {
  final bool isLoading;
  final String text;
  final VoidCallback? onPressed;
  const LoadingButton(
      {super.key, required this.isLoading, required this.text, this.onPressed});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton(
        onPressed: isLoading ? null : onPressed,
        child: isLoading
            ? const SizedBox(
                width: 20, height: 20,
                child: CircularProgressIndicator(
                    color: Colors.white, strokeWidth: 2))
            : Text(text, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
      ),
    );
  }
}
