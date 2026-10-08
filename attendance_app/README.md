# attendance_app

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Lab: Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Cookbook: Useful Flutter samples](https://docs.flutter.dev/cookbook)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.

## Run against a local backend

Start the Flask backend on the computer at `192.168.0.200`, listening on
`0.0.0.0:5000`, and connect the device running the app to the same network.
From the repository root, run:

```powershell
cd attendance_app
flutter run --dart-define=API_BASE_URL=http://192.168.0.200:5000
```

Without `--dart-define`, the app uses the production API.
