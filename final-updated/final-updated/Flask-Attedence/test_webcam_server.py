import cv2
from flask import Flask, Response, render_template_string

app = Flask(__name__)

def generate_frames():
    # Initialize webcam
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    
    if not cap.isOpened():
        print("Failed to open webcam!")
        yield (b'--frame\r\n'
               b'Content-Type: text/plain\r\n\r\n'
               b'Failed to open webcam\r\n')
        return

    while True:
        success, frame = cap.read()
        if not success:
            break
        else:
            # Encode frame as JPEG
            ret, buffer = cv2.imencode('.jpg', frame)
            frame = buffer.tobytes()
            # Yield the output frame in byte format
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')

@app.route('/')
def index():
    return render_template_string('''
        <html>
            <head><title>Webcam Test</title></head>
            <body style="background: black; color: white; text-align: center; font-family: sans-serif;">
                <h1>Direct Webcam Test (Index 0)</h1>
                <img src="/video_feed" style="max-width: 100%; border: 2px solid white;">
            </body>
        </html>
    ''')

@app.route('/video_feed')
def video_feed():
    return Response(generate_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

if __name__ == "__main__":
    print("Starting standalone webcam test server on http://localhost:5005")
    app.run(host='0.0.0.0', port=5005, debug=True)
