# Machine learning

`<gpu/nn>` (inference) and `<gpu/train>` (training). Llama 2 numbers are under [Inference](#inference).

## Inference

[`examples/llama2.esk`](../examples/llama2.esk) is Llama 2 inference after Andrej Karpathy's
llama2.c. It reads llama2.c checkpoints, llama GGUF files (Q4_0 and Q8_0 run quantized on
the GPU, other types are converted to f16) and Hugging Face model directories:

```
$ eskiuc build && ./build/llama2 llama-2-7b.Q4_0.gguf -t 0 -i "The capital of France is"
```

| Model | Eskiu | Reference |
|---|---|---|
| stories110M (llama2.c, f16) | 350 tokens/s | llama2.c on the CPU: 22 tokens/s |
| TinyLlama 1.1B Q4_0 (GGUF) | 178 tokens/s | llama.cpp (Metal): 260 tokens/s |
| Llama 2 7B Q4_0 (GGUF) | 45 tokens/s | llama.cpp (Metal): 58 tokens/s |

<sub>Apple M4 Pro, greedy decoding. The outputs match llama2.c byte for byte and llama.cpp
and Hugging Face transformers token for token on the prompts tested.</sub>

The forward pass is a program of `<gpu/nn>` operations recorded once and replayed as one
compute pass per token: matrix-vector products in f32, f16, Q8_0 and Q4_0 (with subgroup
reductions when the device has them), RMSNorm, rotary embeddings, attention over a KV cache,
SwiGLU and argmax.

`<gpu/train>` trains networks with automatic differentiation and Adam: an MNIST example and the
API are in [docs/ml.md](ml.md).

API reference: [`<gpu/nn>`](api.md#gpunn), [`<gpu/train>`](api.md#gputrain), [`<gpu/gguf>`](api.md#gpugguf), [`<gpu/safetensors>`](api.md#gpusafetensors).

## Training

[`examples/mnist.esk`](examples/mnist.esk) trains a two-layer network on MNIST with
`<gpu/train>` (97% test accuracy in three epochs, about 0.4 s per epoch) and saves the
weights as safetensors, which PyTorch loads with the same accuracy:

```eskiu
NnGraph g = gpu.nn_graph(100)?;
NnVar x = g.input(784);
NnVar labels = g.labels();
NnVar h = g.relu(g.bias(g.matmul(x, g.param(784, 128, 0.05)), g.param(1, 128, 0.0)));
NnVar logits = g.bias(g.matmul(h, g.param(128, 10, 0.125)), g.param(1, 10, 0.0));
NnVar loss = g.cross_entropy(logits, labels);
g.backward(loss)?;   // records the gradients of every operation
g.adam(0.001);       // and the optimizer step
// each batch: g.set_input(x, images); g.set_labels(labels, digits); g.run()?;
```
