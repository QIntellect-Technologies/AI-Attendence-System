import onnxruntime
import numpy as np
from pathlib import Path

model_path = Path('models/minifasnet_v2.onnx')
session = onnxruntime.InferenceSession(str(model_path), providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])

input_name = session.get_inputs()[0].name
input_shape = session.get_inputs()[0].shape
output_shape = session.get_outputs()[0].shape
output_name = session.get_outputs()[0].name

print(f"Input Shape: {input_shape}")
print(f"Output Shape: {output_shape}")

# Test with dummy inputs (zeros and ones) to see raw scores
dummy_input = np.zeros((1, 3, 80, 80), dtype=np.float32)
out_zeros = session.run([output_name], {input_name: dummy_input})[0][0]
print(f"Zeros Output: {out_zeros}")

dummy_input_ones = np.ones((1, 3, 80, 80), dtype=np.float32)
out_ones = session.run([output_name], {input_name: dummy_input_ones})[0][0]
print(f"Ones Output: {out_ones}")
