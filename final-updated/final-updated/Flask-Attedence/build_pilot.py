import os
import sys
import subprocess
import shutil
import venv
from pathlib import Path

def build_pilot():
    print("=" * 60)
    print("[BUILD] Building QIntellect AI Pilot Executable (Clean Environment)...")
    print("=" * 60)

    base_dir = Path(__file__).parent
    venv_dir = base_dir / "pilot_env"

    # Step 0: Ensure no previous instance of QIntellect_Server.exe is running & lock is released
    if os.name == 'nt':
        subprocess.run(["taskkill", "/F", "/IM", "QIntellect_Server.exe"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    
    exe_target = base_dir / "dist" / "QIntellect_Server.exe"
    if exe_target.exists():
        try:
            os.remove(exe_target)
        except Exception as e:
            print(f"[!] Note: Could not remove existing target file directly: {e}")

    # Step 1: Create a clean virtual environment if it doesn't exist
    env_created = False
    if not venv_dir.exists():
        print("[*] Creating a fresh virtual environment (pilot_env)...")
        venv.create(venv_dir, with_pip=True)
        env_created = True
    else:
        print("[*] Virtual environment 'pilot_env' already exists. Reusing installed dependencies.")

    # Determine paths based on OS
    if os.name == 'nt':
        venv_python = venv_dir / "Scripts" / "python.exe"
        venv_pyinstaller = venv_dir / "Scripts" / "pyinstaller.exe"
    else:
        venv_python = venv_dir / "bin" / "python"
        venv_pyinstaller = venv_dir / "bin" / "pyinstaller"

    # Step 2: Install dependencies into venv only if freshly created or pyinstaller missing
    if env_created or not venv_pyinstaller.exists():
        print("\n[*] Installing dependencies from requirements.txt... (First-time setup)")
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "-r", "requirements.txt"], cwd=base_dir)

        print("\n[*] Applying NumPy 1.x fix for Ultralytics/OpenCV compatibility...")
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "numpy<2.0.0"], cwd=base_dir)

        print("\n[*] Installing PyInstaller...")
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "pyinstaller"], cwd=base_dir)
    else:
        print("\n[*] Dependencies up to date. Skipping pip install step for fast build!")

    # Step 3: Fast Incremental PyInstaller Build (Folder Mode / Fast Cache)
    command = [
        str(venv_pyinstaller),
        "--name", "QIntellect_Server",
        "--onedir",
        "--noconsole",
        "--noconfirm",
        "--add-data", f"templates{os.pathsep}templates",
        "--add-data", f"static{os.pathsep}static",
        "--add-data", f"yolov8n.pt{os.pathsep}.",
        "--add-data", f"models{os.pathsep}models",
        "--add-data", f"attendance.db{os.pathsep}.",
        "--add-data", f"face_processor.py{os.pathsep}.",
        "--add-data", f"database.py{os.pathsep}.",
        "--add-data", f"config.py{os.pathsep}.",
        "--add-data", f"logger_config.py{os.pathsep}.",
        "--add-data", f"download_models.py{os.pathsep}.",
        "--collect-data", "insightface",
        "pilot_app.py"
    ]

    print("\n[*] Running Fast PyInstaller compilation...")
    print(" ".join(command))
    subprocess.check_call(command, cwd=base_dir)

    output_dir = base_dir / "dist" / "QIntellect_Server"

    print("=" * 60)
    print("[DONE] FAST PILOT BUILD COMPLETE!")
    print(f"Your executable package is ready in: {output_dir}")
    print("You can zip the 'QIntellect_Server' folder and send it to your client!")
    print("="*60)

if __name__ == "__main__":
    build_pilot()
