# Machine learning

`<gpu/nn>` (inference) and `<gpu/train>` (training). Llama 2 numbers are in the [README](../README.md#machine-learning).

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
