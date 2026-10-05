import os
import sys
import subprocess
import shutil
import venv
from pathlib import Path

def build_ahmad_sultan_pilot():
    print("=" * 60)
    print("[BUILD] Building Ahmad Sultan Pilot Testing Executable...")
    print("=" * 60)

    base_dir = Path(__file__).parent
    venv_dir = base_dir / "pilot_env"
    output_dir = base_dir / "dist" / "Ahmad-Sultan-Pilot-Testing"

    # Step 0: Ensure no previous instance of Ahmad-Sultan-Pilot-Testing.exe is running & lock is released
    if os.name == 'nt':
        subprocess.run(["taskkill", "/F", "/IM", "Ahmad-Sultan-Pilot-Testing.exe"], stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL)

    # Determine paths based on OS
    if os.name == 'nt':
        venv_python = venv_dir / "Scripts" / "python.exe"
        venv_pyinstaller = venv_dir / "Scripts" / "pyinstaller.exe"
    else:
        venv_python = venv_dir / "bin" / "python"
        venv_pyinstaller = venv_dir / "bin" / "pyinstaller"

    if not venv_pyinstaller.exists():
        print("[!] pyinstaller not found in pilot_env. Installing...")
        subprocess.check_call([str(venv_python), "-m", "pip", "install", "pyinstaller"], cwd=base_dir)

    # Step 1: Run PyInstaller compilation
    command = [
        str(venv_pyinstaller),
        "--name", "Ahmad-Sultan-Pilot-Testing",
        "--onedir",
        "--noconsole",
        "--noconfirm",
        "--add-data", f"templates{os.pathsep}templates",
        "--add-data", f"static{os.pathsep}static",
        "--add-data", f"yolov8n.pt{os.pathsep}.",
        "--add-data", f"models{os.pathsep}models",
        "--add-data", f"attendance_ahmad_sultan.db{os.pathsep}.",
        "--add-data", f"attendance_ahmad_sultan.db{os.pathsep}attendance.db",
        "--add-data", f"face_processor.py{os.pathsep}.",
        "--add-data", f"database.py{os.pathsep}.",
        "--add-data", f"config.py{os.pathsep}.",
        "--add-data", f"logger_config.py{os.pathsep}.",
        "--add-data", f"download_models.py{os.pathsep}.",
        "--collect-data", "insightface",
        "pilot_ahmad_sultan.py"
    ]

    print("\n[*] Running PyInstaller compilation for Ahmad-Sultan-Pilot-Testing...")
    print(" ".join(command))
    subprocess.check_call(command, cwd=base_dir)

    # Step 2: Copy fresh client_config_ahmad_sultan.json to dist/Ahmad-Sultan-Pilot-Testing/client_config.json
    client_cfg_src = base_dir / "client_config_ahmad_sultan.json"
    client_cfg_dst = output_dir / "client_config.json"
    if client_cfg_src.exists():
        shutil.copy2(client_cfg_src, client_cfg_dst)
        print(f"[OK] Copied fresh setup wizard config to: {client_cfg_dst}")

    # Step 3: Create deployable ZIP archive
    zip_dst = base_dir / "dist" / "Ahmad-Sultan-Pilot-Testing.zip"
    print(f"\n[*] Creating deployable ZIP archive at: {zip_dst}...")
    shutil.make_archive(str(base_dir / "dist" / "Ahmad-Sultan-Pilot-Testing"), 'zip', root_dir=base_dir / "dist", base_dir="Ahmad-Sultan-Pilot-Testing")
    if zip_dst.exists():
        print(f"[OK] Created ZIP: {zip_dst} ({zip_dst.stat().st_size / (1024*1024):.1f} MB)")

    print("=" * 60)
    print("[DONE] AHMAD SULTAN PILOT BUILD COMPLETE!")
    print(f"Executable folder: {output_dir}")
    print(f"Executable: {output_dir / 'Ahmad-Sultan-Pilot-Testing.exe'}")
    print(f"Deployable archive: {zip_dst}")
    print("=" * 60)

if __name__ == "__main__":
    build_ahmad_sultan_pilot()
