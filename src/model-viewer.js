import {
    AmbientLight,
    DirectionalLight,
    Mesh,
    MeshStandardMaterial,
    PerspectiveCamera,
    Scene,
    Vector3,
    WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

/**
 * @returns {{
 *     dom: HTMLDivElement
 *     update: (data: Uint8Array) => void
 *     destroy: () => void
 * }}
 */
export function createModelViewer() {
    const dom = document.createElement('div')
    dom.className = 'model-preview'

    const scene = new Scene()
    scene.background = null
    const camera = new PerspectiveCamera(45, 1, 0.01, 10000)
    const renderer = new WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.domElement.setAttribute('aria-label', 'Rendered 3D model')
    dom.append(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.addEventListener('change', render)
    scene.add(new AmbientLight(0xffffff, 1.8))
    const keyLight = new DirectionalLight(0xffffff, 2.4)
    keyLight.position.set(1, 2, 3)
    scene.add(keyLight)
    const fillLight = new DirectionalLight(0xffffff, 1.2)
    fillLight.position.set(-2, -1, -2)
    scene.add(fillLight)

    /** @type {Mesh | null} */
    let mesh = null
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(dom)
    controls.update()
    resize()

    /** @param {Mesh} item */
    function disposeMesh(item) {
        scene.remove(item)
        item.geometry.dispose()
        if (Array.isArray(item.material)) {
            item.material.forEach((material) => material.dispose())
        } else {
            item.material.dispose()
        }
    }

    function render() {
        renderer.render(scene, camera)
    }

    function resize() {
        const { width, height } = dom.getBoundingClientRect()
        if (!width || !height) return
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        render()
    }

    return {
        dom,
        update(data) {
            if (mesh) disposeMesh(mesh)

            const buffer = new ArrayBuffer(data.byteLength)
            new Uint8Array(buffer).set(data)
            const geometry = new STLLoader().parse(buffer)
            geometry.computeBoundingBox()
            geometry.center()
            geometry.computeBoundingSphere()

            const material = new MeshStandardMaterial({
                color: 0x61b4d7,
                metalness: 0.12,
                roughness: 0.58,
            })
            mesh = new Mesh(geometry, material)
            scene.add(mesh)

            const size = geometry.boundingBox?.getSize(new Vector3())
            const largestDimension = size ? Math.max(size.x, size.y, size.z) : 1
            const distance = Math.max(largestDimension * 1.8, 1)
            camera.near = Math.max(largestDimension / 1000, 0.01)
            camera.far = Math.max(largestDimension * 100, 100)
            camera.position.set(distance, distance, distance)
            camera.lookAt(0, 0, 0)
            controls.target.set(0, 0, 0)
            controls.update()
            render()
        },
        destroy() {
            resizeObserver.disconnect()
            controls.removeEventListener('change', render)
            controls.dispose()
            if (mesh) disposeMesh(mesh)
            renderer.dispose()
            renderer.domElement.remove()
        },
    }
}
