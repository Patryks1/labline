import * as THREE from 'three'

export interface HallModelDimensions {
  width: number
  depth: number
  height: number
}

/** A floor-relative transform. Rotation is around the asset's floor-centre. */
export interface HallModelTransform {
  position: THREE.Vector3 | readonly [x: number, y: number, z: number]
  rotationY?: number
}

export interface RackModelOptions extends HallModelDimensions {
  skuId: string
  selected?: boolean
  offline?: boolean
}

export type HallEquipmentKind = 'cooling' | 'power' | 'network'

export interface HallEquipmentModelOptions extends HallModelDimensions {
  kind: HallEquipmentKind
  selected?: boolean
  offline?: boolean
}

type MaterialSet = {
  cabinet: THREE.MeshStandardMaterial
  dark: THREE.MeshStandardMaterial
  inset: THREE.MeshStandardMaterial
  accent: THREE.MeshStandardMaterial
  light: THREE.MeshStandardMaterial
  warning: THREE.MeshStandardMaterial
}

function validDimension(value: number, name: keyof HallModelDimensions): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

function dimensions(options: HallModelDimensions): HallModelDimensions {
  return {
    width: validDimension(options.width, 'width'),
    depth: validDimension(options.depth, 'depth'),
    height: validDimension(options.height, 'height'),
  }
}

/** Stable FNV-1a hash so a SKU always gets the same visual variant. */
export function rackVariantSeed(skuId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < skuId.length; index += 1) {
    hash ^= skuId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function rackMaterials(seed: number, selected: boolean, offline: boolean): MaterialSet {
  const hue = ((seed % 37) + 184) / 360
  const cabinetColor = new THREE.Color().setHSL(hue, 0.22 + ((seed >>> 8) % 8) / 100, 0.115 + ((seed >>> 12) % 5) / 100)
  const accentColor = new THREE.Color().setHSL(hue, 0.72, selected ? 0.62 : 0.48)
  const lightColor = offline ? new THREE.Color(0xf05252) : new THREE.Color(0x69f0d0)
  return {
    cabinet: new THREE.MeshStandardMaterial({ name: 'rack-cabinet', color: cabinetColor, metalness: 0.82, roughness: 0.3 }),
    dark: new THREE.MeshStandardMaterial({ name: 'rack-door', color: 0x080c10, metalness: 0.76, roughness: 0.3 }),
    inset: new THREE.MeshStandardMaterial({ name: 'rack-inset', color: 0x172028, metalness: 0.6, roughness: 0.42 }),
    accent: new THREE.MeshStandardMaterial({ name: 'rack-accent', color: accentColor, emissive: accentColor, emissiveIntensity: selected ? 0.62 : 0.12, metalness: 0.5, roughness: 0.3 }),
    light: new THREE.MeshStandardMaterial({ name: offline ? 'rack-led-offline' : 'rack-led', color: lightColor, emissive: lightColor, emissiveIntensity: offline ? 0.18 : 1.15, roughness: 0.25 }),
    warning: new THREE.MeshStandardMaterial({ name: 'rack-warning', color: 0xffb54c, emissive: 0x9a3c0d, emissiveIntensity: 0.35, roughness: 0.45 }),
  }
}

function equipmentMaterials(kind: HallEquipmentKind, selected: boolean, offline: boolean): MaterialSet {
  const colors: Record<HallEquipmentKind, number> = { cooling: 0x247f91, power: 0xa96f20, network: 0x414d9d }
  const accents: Record<HallEquipmentKind, number> = { cooling: 0x63e2ef, power: 0xffbf55, network: 0x8f9cff }
  const accentColor = new THREE.Color(offline ? 0xa84444 : accents[kind])
  return {
    cabinet: new THREE.MeshStandardMaterial({ name: `${kind}-cabinet`, color: colors[kind], metalness: 0.62, roughness: 0.4 }),
    dark: new THREE.MeshStandardMaterial({ name: `${kind}-panel`, color: 0x090d12, metalness: 0.7, roughness: 0.34 }),
    inset: new THREE.MeshStandardMaterial({ name: `${kind}-inset`, color: 0x202a32, metalness: 0.55, roughness: 0.46 }),
    accent: new THREE.MeshStandardMaterial({ name: `${kind}-accent`, color: accentColor, emissive: accentColor, emissiveIntensity: selected ? 0.58 : 0.15, metalness: 0.42, roughness: 0.32 }),
    light: new THREE.MeshStandardMaterial({ name: `${kind}-status`, color: accentColor, emissive: accentColor, emissiveIntensity: offline ? 0.12 : 0.9, roughness: 0.25 }),
    warning: new THREE.MeshStandardMaterial({ name: `${kind}-warning`, color: 0xffc04d, emissive: 0x7d3b08, emissiveIntensity: 0.25, roughness: 0.5 }),
  }
}

function box(
  group: THREE.Group,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: THREE.Material,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material)
  mesh.position.set(...position)
  mesh.name = name
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

function applyTransform(group: THREE.Group, transform: HallModelTransform): void {
  if (transform.position instanceof THREE.Vector3) group.position.copy(transform.position)
  else group.position.set(transform.position[0], transform.position[1], transform.position[2])
  group.rotation.y = transform.rotationY ?? 0
}

const frontFaceZ = (depth: number, detailDepth: number): number => depth / 2 - detailDepth / 2

function addCabinetFrame(group: THREE.Group, d: HallModelDimensions, materials: MaterialSet): void {
  const post = Math.min(d.width, d.depth, d.height) * 0.035
  const rail = Math.max(post, d.height * 0.018)
  const x = d.width / 2 - post / 2
  const z = d.depth / 2 - post / 2
  for (const px of [-x, x]) for (const pz of [-z, z]) {
    box(group, [post, d.height, post], [px, d.height / 2, pz], materials.cabinet, 'cabinet-post')
  }
  for (const y of [rail / 2, d.height - rail / 2]) {
    box(group, [d.width, rail, post], [0, y, -z], materials.cabinet, 'cabinet-rail')
    box(group, [d.width, rail, post], [0, y, z], materials.cabinet, 'cabinet-rail')
    box(group, [post, rail, d.depth], [-x, y, 0], materials.cabinet, 'cabinet-rail')
    box(group, [post, rail, d.depth], [x, y, 0], materials.cabinet, 'cabinet-rail')
  }
  const sideThickness = Math.max(0.002, post * 0.36)
  box(group, [sideThickness, d.height - rail * 2, d.depth - post * 2], [-d.width / 2 + sideThickness / 2, d.height / 2, 0], materials.inset, 'cabinet-side')
  box(group, [sideThickness, d.height - rail * 2, d.depth - post * 2], [d.width / 2 - sideThickness / 2, d.height / 2, 0], materials.inset, 'cabinet-side')
}

/** Creates a detailed rack with its origin at the centre of its footprint on the floor. Front faces +Z. */
export function createDetailedRackModel(options: RackModelOptions): THREE.Group {
  const d = dimensions(options)
  const seed = rackVariantSeed(options.skuId)
  const materials = rackMaterials(seed, options.selected ?? false, options.offline ?? false)
  const group = new THREE.Group()
  group.name = `rack:${options.skuId}`
  group.userData = { assetKind: 'rack', skuId: options.skuId, selected: options.selected ?? false, offline: options.offline ?? false }
  addCabinetFrame(group, d, materials)

  const faceDepth = Math.max(0.002, d.depth * 0.018)
  const frontZ = frontFaceZ(d.depth, faceDepth)
  const rearZ = -frontZ
  box(group, [d.width * 0.9, d.height * 0.91, faceDepth], [0, d.height * 0.5, rearZ], materials.dark, 'rear-door')
  box(group, [d.width * 0.9, d.height * 0.91, faceDepth], [0, d.height * 0.5, frontZ], materials.dark, 'front-door')

  const sledCount = 9 + (seed % 6)
  const bankTop = d.height * 0.88
  const bankBottom = d.height * 0.1
  const pitch = (bankTop - bankBottom) / sledCount
  const sledHeight = pitch * (0.62 + ((seed >>> 5) % 18) / 100)
  const sledDepth = Math.max(0.002, faceDepth * 0.72)
  const sledZ = frontFaceZ(d.depth, sledDepth)
  for (let index = 0; index < sledCount; index += 1) {
    const y = bankBottom + pitch * (index + 0.5)
    box(group, [d.width * 0.77, sledHeight, sledDepth], [0, y, sledZ], materials.inset, 'server-sled')
    const ventCount = 4 + ((seed + index) % 3)
    for (let vent = 0; vent < ventCount; vent += 1) {
      const vx = -d.width * 0.21 + (d.width * 0.42 * vent) / Math.max(1, ventCount - 1)
      const ventDepth = sledDepth * 0.45
      box(group, [d.width * 0.025, sledHeight * 0.42, ventDepth], [vx, y, frontFaceZ(d.depth, ventDepth)], materials.dark, 'sled-vent')
    }
    if ((index + seed) % 3 !== 0) {
      const ledDepth = sledDepth * 0.5
      box(group, [d.width * 0.018, Math.min(sledHeight * 0.3, d.height * 0.008), ledDepth], [d.width * 0.33, y, frontFaceZ(d.depth, ledDepth)], materials.light, 'status-led')
    }
    if ((index + seed) % 4 === 0) {
      const handleDepth = sledDepth * 0.45
      box(group, [d.width * 0.09, sledHeight * 0.16, handleDepth], [-d.width * 0.31, y, frontFaceZ(d.depth, handleDepth)], materials.accent, 'sled-handle')
    }
  }

  const railWidth = d.width * 0.035
  for (const x of [-d.width * 0.415, d.width * 0.415]) {
    box(group, [railWidth, d.height * 0.78, faceDepth * 0.7], [x, d.height * 0.49, sledZ], materials.accent, 'mounting-rail')
  }
  const headerHeight = d.height * 0.045
  box(group, [d.width * 0.62, headerHeight, sledDepth], [0, d.height * 0.935, sledZ], materials.cabinet, 'rack-header')
  const identifierDepth = sledDepth * 0.55
  box(group, [d.width * 0.2, headerHeight * 0.34, identifierDepth], [0, d.height * 0.935, frontFaceZ(d.depth, identifierDepth)], options.offline ? materials.warning : materials.accent, 'rack-identifier')
  return group
}

/** Creates and places a rack under a caller-owned scene/group. */
export function addDetailedRackModel(parent: THREE.Object3D, options: RackModelOptions, transform: HallModelTransform): THREE.Group {
  const group = createDetailedRackModel(options)
  applyTransform(group, transform)
  parent.add(group)
  return group
}

function addStatusHeader(group: THREE.Group, d: HallModelDimensions, materials: MaterialSet, label: string): void {
  const headerDepth = d.depth * 0.018
  const statusDepth = d.depth * 0.01
  box(group, [d.width * 0.64, d.height * 0.055, headerDepth], [0, d.height * 0.92, frontFaceZ(d.depth, headerDepth)], materials.dark, `${label}-header`)
  box(group, [d.width * 0.24, d.height * 0.012, statusDepth], [0, d.height * 0.92, frontFaceZ(d.depth, statusDepth)], materials.light, `${label}-status`)
}

function addCoolingDetails(group: THREE.Group, d: HallModelDimensions, materials: MaterialSet): void {
  const detailDepth = d.depth * 0.025
  const frontZ = frontFaceZ(d.depth, detailDepth)
  const slats = 9
  for (let index = 0; index < slats; index += 1) {
    const y = d.height * (0.13 + index * 0.072)
    box(group, [d.width * 0.72, d.height * 0.018, detailDepth], [0, y, frontZ], index % 3 === 0 ? materials.accent : materials.dark, 'cooling-louvre')
  }
  const fanHeight = d.height * 0.035
  for (const x of [-d.width * 0.23, d.width * 0.23]) {
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(d.width * 0.16, d.width * 0.16, fanHeight, 20), materials.dark)
    fan.position.set(x, d.height - fanHeight / 2, 0)
    fan.name = 'cooling-fan'
    fan.castShadow = true
    group.add(fan)
  }
  box(group, [d.width * 0.06, d.height * 0.58, detailDepth], [-d.width * 0.4, d.height * 0.44, frontZ], materials.accent, 'coolant-pipe')
}

function addPowerDetails(group: THREE.Group, d: HallModelDimensions, materials: MaterialSet): void {
  const panelDepth = d.depth * 0.025
  const frontZ = frontFaceZ(d.depth, panelDepth)
  box(group, [d.width * 0.78, d.height * 0.7, panelDepth], [0, d.height * 0.46, frontZ], materials.dark, 'power-breaker-panel')
  for (let row = 0; row < 7; row += 1) for (let column = 0; column < 3; column += 1) {
    const breakerDepth = d.depth * 0.014
    box(group, [d.width * 0.17, d.height * 0.045, breakerDepth], [(column - 1) * d.width * 0.23, d.height * (0.21 + row * 0.075), frontFaceZ(d.depth, breakerDepth)], row === 6 ? materials.warning : materials.inset, 'breaker')
  }
  const busDepth = d.depth * 0.03
  box(group, [d.width * 0.06, d.height * 0.42, busDepth], [d.width * 0.43, d.height * 0.46, frontFaceZ(d.depth, busDepth)], materials.accent, 'power-bus')
}

function addNetworkDetails(group: THREE.Group, d: HallModelDimensions, materials: MaterialSet): void {
  const switchDepth = d.depth * 0.025
  const frontZ = frontFaceZ(d.depth, switchDepth)
  const panelCount = 7
  for (let panel = 0; panel < panelCount; panel += 1) {
    const y = d.height * (0.18 + panel * 0.09)
    box(group, [d.width * 0.8, d.height * 0.055, switchDepth], [0, y, frontZ], panel % 3 === 2 ? materials.accent : materials.dark, 'network-switch')
    for (let port = 0; port < 8; port += 1) {
      const portDepth = d.depth * 0.012
      box(group, [d.width * 0.045, d.height * 0.014, portDepth], [d.width * (-0.28 + port * 0.08), y, frontFaceZ(d.depth, portDepth)], (panel + port) % 5 === 0 ? materials.light : materials.inset, 'network-port')
    }
  }
  for (const x of [-d.width * 0.43, d.width * 0.43]) {
    const managerDepth = d.depth * 0.025
    box(group, [d.width * 0.035, d.height * 0.61, managerDepth], [x, d.height * 0.48, frontFaceZ(d.depth, managerDepth)], materials.accent, 'cable-manager')
  }
}

/** Creates recognizable cooling, power, or network infrastructure at floor-centre origin. */
export function createHallEquipmentModel(options: HallEquipmentModelOptions): THREE.Group {
  const d = dimensions(options)
  const materials = equipmentMaterials(options.kind, options.selected ?? false, options.offline ?? false)
  const group = new THREE.Group()
  group.name = `hall-equipment:${options.kind}`
  group.userData = { assetKind: options.kind, selected: options.selected ?? false, offline: options.offline ?? false }
  addCabinetFrame(group, d, materials)
  box(group, [d.width * 0.91, d.height * 0.9, d.depth * 0.94], [0, d.height * 0.49, 0], materials.cabinet, `${options.kind}-body`)
  addStatusHeader(group, d, materials, options.kind)
  if (options.kind === 'cooling') addCoolingDetails(group, d, materials)
  else if (options.kind === 'power') addPowerDetails(group, d, materials)
  else addNetworkDetails(group, d, materials)
  return group
}

export function createCoolingEquipmentModel(options: Omit<HallEquipmentModelOptions, 'kind'>): THREE.Group {
  return createHallEquipmentModel({ ...options, kind: 'cooling' })
}

export function createPowerEquipmentModel(options: Omit<HallEquipmentModelOptions, 'kind'>): THREE.Group {
  return createHallEquipmentModel({ ...options, kind: 'power' })
}

export function createNetworkEquipmentModel(options: Omit<HallEquipmentModelOptions, 'kind'>): THREE.Group {
  return createHallEquipmentModel({ ...options, kind: 'network' })
}

export function addHallEquipmentModel(parent: THREE.Object3D, options: HallEquipmentModelOptions, transform: HallModelTransform): THREE.Group {
  const group = createHallEquipmentModel(options)
  applyTransform(group, transform)
  parent.add(group)
  return group
}
