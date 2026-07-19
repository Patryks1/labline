import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { BuildDef } from '../../../sim/types'
import { createBuildingKit } from '../../three/buildingKits'

export function FacilityModelPreview({ definition }: { definition: BuildDef }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.setClearColor(0x071016, 0)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30)
    camera.position.set(2.5, 2.1, 3.1)
    camera.lookAt(0, 0.25, 0)
    scene.add(new THREE.HemisphereLight(0xa9e8df, 0x101820, 2.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.8)
    key.position.set(3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x2dd4bf, 1.4)
    rim.position.set(-3, 2, -4)
    scene.add(rim)

    const footprint = definition.footprint?.length ?? 1
    const height = definition.kind === 'dc_l' || definition.kind === 'hq_l'
      ? 1
      : definition.kind === 'dc_m' || definition.kind === 'hq_m'
        ? 0.9
        : 0.72
    const model = createBuildingKit(definition.kind, 0x3dffc0, height, 3, 5)
    const footprintScale = footprint >= 6 ? 1.7 : footprint >= 4 ? 1.38 : 1
    model.scale.set(footprintScale, footprintScale, footprintScale)
    model.rotation.y = -0.65
    scene.add(model)

    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.18, 1.3, 0.08, 6),
      new THREE.MeshStandardMaterial({ color: 0x13252b, roughness: 0.88, metalness: 0.15 }),
    )
    pad.position.y = -0.06
    scene.add(pad)

    let frame = 0
    let disposed = false
    const render = () => {
      if (disposed) return
      frame = requestAnimationFrame(render)
      model.rotation.y += 0.0025
      renderer.render(scene, camera)
    }
    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const heightPx = Math.max(1, host.clientHeight)
      renderer.setSize(width, heightPx, false)
      camera.aspect = width / heightPx
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()
    render()

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return
        if (!object.geometry.userData.shared) object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        for (const material of materials) material.dispose()
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [definition])

  return (
    <div
      ref={hostRef}
      className="h-44 w-full overflow-hidden rounded-xl border border-mint/20 bg-[radial-gradient(circle_at_50%_35%,rgba(61,255,192,0.08),transparent_62%)]"
      aria-label={`${definition.label} interactive 3D model preview`}
      role="img"
    />
  )
}
