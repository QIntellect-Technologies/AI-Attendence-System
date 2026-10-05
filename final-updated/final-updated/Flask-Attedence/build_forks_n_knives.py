import os
import subprocess
import shutil
from pathlib import Path


def build_forks_n_knives_pilot():
    print("=" * 60)
    print("[BUILD] Building Forks N Knives Pilot Executable...")
    print("=" * 60)

    base_dir = Path(__file__).parent
    # Use a SHORT dist path to avoid Windows MAX_PATH (260 char) limit.
    # jedi/IPython typeshed stubs produce paths > 260 chars with the long project path.
    short_dist = Path(r"C:\FnK_Build")
    short_dist.mkdir(parents=True, exist_ok=True)
    short_work = short_dist / "work"
    short_work.mkdir(parents=True, exist_ok=True)
    output_dir = short_dist / "Forks-N-Knives-Pilot"
    final_dist  = base_dir / "dist" / "Forks-N-Knives-Pilot"

    # Step 0: Kill any running instance to release file locks
    if os.name == 'nt':
        subprocess.run(
            ["taskkill", "/F", "/IM", "Forks-N-Knives-Pilot.exe"],
            stderr=subprocess.DEVNULL, stdout=subprocess.DEVNULL
        )

    # Match the lean environment used by the Ahmad Sultan pilot.
    build_python = base_dir / "pilot_env" / "Scripts" / "python.exe"
    if not build_python.is_file():
        raise FileNotFoundError(f"Pilot build Python not found: {build_python}")
    print(f"[*] Using Python: {build_python}")

    try:
        subprocess.check_call(
            [str(build_python), "-m", "PyInstaller", "--version"],
            cwd=base_dir,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError:
        print("[!] PyInstaller not found in pilot_env. Installing...")
        subprocess.check_call(
            [str(build_python), "-m", "pip", "install", "pyinstaller"],
            cwd=base_dir,
        )

    # Step 1: Run PyInstaller compilation
    command = [
        str(build_python), "-m", "PyInstaller",
        "--name", "Forks-N-Knives-Pilot",
        "--onedir",
        "--noconsole",
        "--noconfirm",
        # Short paths to avoid Windows MAX_PATH (260 char) limit
        "--distpath", str(short_dist),
        "--workpath", str(short_work),
        "--add-data", f"templates{os.pathsep}templates",
        "--add-data", f"static{os.pathsep}static",
        "--add-data", f"yolov8n.pt{os.pathsep}.",
        "--add-data", f"models{os.pathsep}models",
        "--add-data", f"attendance_forks_n_knives.db{os.pathsep}.",
        "--add-data", f"attendance_forks_n_knives.db{os.pathsep}attendance.db",
        "--add-data", f"face_processor.py{os.pathsep}.",
        "--add-data", f"database.py{os.pathsep}.",
        "--add-data", f"config.py{os.pathsep}.",
        "--add-data", f"logger_config.py{os.pathsep}.",
        "--add-data", f"download_models.py{os.pathsep}.",
        "--collect-data", "insightface",
        "pilot_forks_n_knives.py"
    ]

    print("\n[*] Running PyInstaller compilation for Forks-N-Knives-Pilot...")
    print(" ".join(command))
    subprocess.check_call(command, cwd=base_dir)

    # Step 2: Move output from short path to standard dist/ folder
    print(f"\n[*] Moving build output to: {final_dist}")
    if final_dist.exists():
        shutil.rmtree(final_dist)
    shutil.copytree(str(output_dir), str(final_dist))
    print(f"[OK] Copied to: {final_dist}")

    # Step 3: Copy fresh client_config to dist folder
    client_cfg_src = base_dir / "client_config_forks_n_knives.json"
    client_cfg_dst = final_dist / "client_config.json"
    if client_cfg_src.exists():
        shutil.copy2(client_cfg_src, client_cfg_dst)
        print(f"[OK] Copied setup wizard config to: {client_cfg_dst}")

    # Step 4: Create deployable ZIP archive
    zip_dst = base_dir / "dist" / "Forks-N-Knives-Pilot.zip"
    print(f"\n[*] Creating deployable ZIP archive at: {zip_dst}...")
    (base_dir / "dist").mkdir(parents=True, exist_ok=True)
    shutil.make_archive(
        str(base_dir / "dist" / "Forks-N-Knives-Pilot"),
        'zip',
        root_dir=base_dir / "dist",
        base_dir="Forks-N-Knives-Pilot"
    )
    if zip_dst.exists():
        print(f"[OK] Created ZIP: {zip_dst} ({zip_dst.stat().st_size / (1024*1024):.1f} MB)")

    print("=" * 60)
    print("[DONE] FORKS N KNIVES PILOT BUILD COMPLETE!")
    print(f"Executable folder : {final_dist}")
    print(f"Executable        : {final_dist / 'Forks-N-Knives-Pilot.exe'}")
    print(f"Deployable archive: {zip_dst}")
    print("=" * 60)


if __name__ == "__main__":
    build_forks_n_knives_pilot()
