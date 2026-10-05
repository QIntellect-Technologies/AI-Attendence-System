import onnxruntime
import numpy as np

session = onnxruntime.InferenceSession('models/minifasnet_v2.onnx', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
input_name = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name

dummy_input_128 = np.full((1, 3, 80, 80), 128.0, dtype=np.float32)
out_128 = session.run([output_name], {input_name: dummy_input_128})[0][0]
print(f"128 Output (0-255 scale): {out_128}")

dummy_input_0_5 = np.full((1, 3, 80, 80), 0.5, dtype=np.float32)
out_0_5 = session.run([output_name], {input_name: dummy_input_0_5})[0][0]
print(f"0.5 Output (0-1 scale): {out_0_5}")

# test random noise in 0-255
dummy_rand_255 = np.random.uniform(0, 255, (1, 3, 80, 80)).astype(np.float32)
out_rand_255 = session.run([output_name], {input_name: dummy_rand_255})[0][0]
print(f"Random 0-255 Output: {out_rand_255}")

# test random noise in 0-1
dummy_rand_1 = np.random.uniform(0, 1, (1, 3, 80, 80)).astype(np.float32)
out_rand_1 = session.run([output_name], {input_name: dummy_rand_1})[0][0]
print(f"Random 0-1 Output: {out_rand_1}")
