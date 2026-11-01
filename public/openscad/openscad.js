/// <reference types="./openscad.d.ts" />
async function OpenSCAD(options) {
    const module = {
        noInitialRun: true,
        locateFile: (path) => new URL(`./${path}`, import.meta.url).href,
        ...options,
    };
    globalThis.OpenSCAD = module;
    const script = document.createElement("script");
    script.src = new URL(`./openscad.wasm.js`, import.meta.url).href;
    try {
        await new Promise((resolve, reject) => {
            module.onRuntimeInitialized = () => resolve(null);
            script.onerror = () => reject(new Error("Failed to load OpenSCAD runtime."));
            document.head.append(script);
        });
        return module;
    } finally {
        delete globalThis.OpenSCAD;
        script.remove();
    }
}

export { OpenSCAD as default };
