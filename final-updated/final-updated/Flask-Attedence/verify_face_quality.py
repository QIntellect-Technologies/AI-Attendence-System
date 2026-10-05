import cv2
import numpy as np
import face_processor as fp

img = np.zeros((200, 200, 3), dtype=np.uint8)
face = np.full((80, 80, 3), 180, dtype=np.uint8)
cv2.rectangle(face, (10, 10), (70, 70), (220, 220, 220), -1)
face = cv2.GaussianBlur(face, (9, 9), 0)
img[60:140, 60:140] = face
result = fp.assess_face_quality(img, (60, 60, 140, 140))
print(result)
print('score=', result['score'])
print('threshold=', fp.config.FACE_QUALITY_THRESHOLD if hasattr(fp, 'config') else 'n/a')
