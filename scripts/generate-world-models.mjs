import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Node does not expose FileReader, which GLTFExporter uses to assemble a GLB.
globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => { this.result = value; this.onloadend?.() })
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`
      this.onloadend?.()
    })
  }
}

const outputDir = path.resolve('public/assets/world-v4')
const municipalLayouts = JSON.parse(await readFile(
  path.resolve('src/view/three/assets/municipalPowerLayouts.json'), 'utf8',
))
if (municipalLayouts.version !== 1 || municipalLayouts.campuses?.length !== 4) {
  throw new Error('Malformed municipal power layout descriptor')
}
const whiteMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true })
const C = {
  leaf: 0x4f8745, leafDark: 0x2f6339, leafLight: 0x82a94d, bark: 0x76543b,
  wall: 0xe5d5b7, wall2: 0xc69c74, roof: 0x7a4b42, glass: 0x78a9bd,
  concrete: 0x9aa2a0, metal: 0x596872, dark: 0x303b42, accent: 0xe6a93d,
  red: 0xb84d45, blue: 0x407d9c, watercraft: 0xe8dfc7, rock: 0x74766f,
  mass: 0xb8b4a8, trim: 0x5a4030, panel: 0x6a9bb8,
}

let nextCatalogId = 400
const definitions = [
  ...catalog('terrain', [
    ['ground-rock',236],['ground-log',237],'grass-tufts','meadow-flowers','dry-scrub','fern-cluster','pebble-group','granite-outcrop','sandstone-outcrop','fallen-pine','fallen-birch','shore-reeds','cattail-clump','mushroom-ring','wild-grass','hill-boulders',
  ], 'base', [1,1], (lod, i) => i % 3 === 1 ? fallenLog(lod) : rocks(lod)),
  ...catalog('vegetation', [
    ['forest-pine',1],['forest-oak',231],'scots-pine','spruce-tall','fir-young','cedar-wide','birch-white','aspen-column','maple-red','beech-round','willow-droop','poplar-tall','dead-pine','dead-oak','hawthorn-shrub','flowering-shrub','juniper-scrub','mixed-grove','pine-grove','birch-grove',
  ], 'base', [1,1], (lod, i) => i % 2 ? oak(lod) : pine(lod)),
  ...catalog('residential', [
    ['house-single',2],'house-duplex','house-terrace','house-townhome','house-row','house-courtyard','house-garden','house-stilt','house-corner','house-cottage','house-modern','apartment-walkup','apartment-brick','apartment-courtyard',
  ], 'base', [1,1], lod => house(lod)),
  ...catalog('urban', [
    ['city-district-a',3],['city-district-b',4],'office-glass','office-stepped','mixed-use-podium','mixed-use-corner','civic-hall','public-library','covered-market','city-hotel','shopping-arcade','transit-hub','clock-tower','hospital-block','university-hall','broadcast-tower',
  ], 'base', [1,1], lod => tower(lod)),
  ...catalog('industrial', [
    ['warehouse',5],'warehouse-sawtooth','warehouse-cold-store','warehouse-depot','warehouse-freight','container-yard','grain-silos','tank-yard','light-industry','rail-terminal',
  ], 'base', [1,1], lod => warehouse(lod)),
  ...catalog('facilities', [
    ['facility-small',100],['facility-medium',101],['facility-large',102],['headquarters',110],['solar-field',111],['grid-substation',112],['power-generation',113],['chip-fabrication',114],['cooling-campus',115],['gas-generation',116],['battery-yard',117],['office-campus',118],['headquarters-small',119],['headquarters-medium',120],['research-lab',121],'training-centre','network-operations','construction-shell','utility-plant','security-centre',
  ], 'base', [2,2], (lod, _i, key) => facilityModel(lod, key), { vary: false }),
  ...municipalLayouts.campuses.map(campus => model(
    'municipal', campus.key, campus.archetypeId, 'base', municipalLayouts.footprint,
    lod => municipalCampus(campus, lod),
  )),
  ...catalog('vehicles', [
    ['city-bus',300],'compact-car','sedan-car','estate-car','delivery-van','cargo-van','pickup-truck','box-truck','semi-truck','tanker-truck','service-truck','electric-shuttle',
  ], 'base', [1,1], lod => bus(lod)),
  ...catalog('boats', [
    ['utility-boat',301],'rowboat','lake-dinghy','sailboat-small','sailboat-cabin',
  ], 'base', [1,1], lod => boat(lod)),
  ...catalog('ducks', [
    ['mallard-pair',302],'brown-duck','duckling-group',
  ], 'base', [1,1], lod => ducks(lod)),
  ...catalog('props', [
    ['road-lamp',210],['park-details',207],['park-bench',303],'traffic-light','pedestrian-signal','road-sign','street-bollards','fire-hydrant','utility-box','wood-fence','highway-guardrail','construction-barrier',
  ], 'base', [1,1], (lod, i) => roadProp(lod, i)),
]

function model(family, key, archetypeId, tintMode, footprint, build) {
  return { family, key, archetypeId, tintMode, footprint, build }
}

function catalog(family, specs, tintMode, footprint, buildBase, opts = {}) {
  const vary = opts.vary !== false
  return specs.map((spec, index) => {
    const [key, explicitId] = Array.isArray(spec) ? spec : [spec, undefined]
    const id = explicitId ?? nextCatalogId++
    return model(family, key, id, tintMode, footprint, lod => {
      const geometry = buildBase(lod, index, key)
      return vary ? varied(geometry, index, family, lod) : geometry
    })
  })
}

/** Give every catalog entry a distinct silhouette, proportions, and accent. */
function varied(base, index, family, lod) {
  const sx = .86 + (index % 5) * .07
  // The monotonic term guarantees a unique vertical proportion even after
  // the modular width/depth patterns repeat in larger (20-entry) families.
  const sy = .86 + ((index * 3) % 6) * .055 + index * .004
  const sz = .87 + ((index * 7) % 5) * .065
  base.scale(sx, sy, sz)
  if (index === 0) return base
  const accent = index % 3 === 0 ? C.accent : index % 3 === 1 ? C.glass : C.wall2
  const size = lod === 'near' ? .08 : lod === 'mid' ? .055 : .035
  let detail
  if (family === 'vegetation') detail = sphere(size * 1.8, 0, [((index % 3)-1)*.16,.52 + (index%4)*.1,.1], accent, [1,.7,1])
  else if (family === 'vehicles') detail = box([size*2,.04,.31],[(index%3-1)*.16,.38,0],accent)
  else if (family === 'boats') detail = box([.02,size*5,.2],[.06,.38,0],accent,[0,0,(index%2?.22:-.16)])
  else if (family === 'ducks') detail = sphere(size,0,[-.18,.08,(index-1)*.08],C.accent,[1,.7,1.2])
  else if (family === 'terrain') detail = cone(size*1.3,size*2.4,5,[.18,.06,-.16],accent)
  else if (family === 'props') detail = box([size*2,size*2,size*2],[.2,size,-.18],accent)
  else detail = box([size*2,size*3,size*2],[.18 + (index%2)*.12,.45 + (index%5)*.1,-.18],accent)
  return merge([base, detail])
}

function painted(geometry, color) {
  const count = geometry.getAttribute('position').count
  const c = new THREE.Color(color)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) c.toArray(colors, i * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function part(geometry, color, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  painted(geometry, color)
  geometry.rotateX(rotation[0]); geometry.rotateY(rotation[1]); geometry.rotateZ(rotation[2])
  geometry.scale(...scale); geometry.translate(...position)
  return geometry.index ? geometry.toNonIndexed() : geometry
}

const box = (size, position, color, rotation) => part(new THREE.BoxGeometry(...size), color, position, rotation)
const cyl = (r1, r2, height, sides, position, color, rotation) => part(new THREE.CylinderGeometry(r1, r2, height, sides), color, position, rotation)
const cone = (radius, height, sides, position, color, rotation) => part(new THREE.ConeGeometry(radius, height, sides), color, position, rotation)
const sphere = (radius, detail, position, color, scale) => part(new THREE.IcosahedronGeometry(radius, detail), color, position, [0, 0, 0], scale)
const merge = parts => {
  const geometry = mergeGeometries(parts, false)
  if (!geometry) throw new Error('Could not merge model geometry')
  geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere()
  for (const item of parts) item.dispose()
  return geometry
}

function rocks(lod) {
  const p = [sphere(.18, lod === 'near' ? 1 : 0, [-.15,.1,.02], C.rock, [1.5,.7,1]), sphere(.11,0,[.17,.06,-.1],0x969080,[1,.65,1.3])]
  if (lod === 'near') p.push(sphere(.06,0,[.28,.035,.12],0x5e625e,[1.4,.5,1]))
  return merge(p)
}
function fallenLog(lod) {
  const p=[cyl(.055,.065,.58,lod==='near'?10:6,[0,.07,0],C.bark,[0,0,Math.PI/2]), cone(.12,.18,6,[-.2,.09,.18],C.leafDark)]
  if(lod==='near') p.push(cyl(.018,.02,.23,6,[.08,.17,0],C.bark,[0,0,-.55]))
  return merge(p)
}
function pine(lod) {
  const sides=lod==='near'?9:lod==='mid'?6:4
  const p=[cyl(.045,.065,.72,sides,[0,.36,0],C.bark),cone(.34,.62,sides,[0,.48,0],C.leafDark),cone(.29,.57,sides,[0,.75,0],C.leaf),cone(.2,.47,sides,[0,1.0,0],C.leafLight)]
  if(lod==='far') return merge([cyl(.04,.055,.5,4,[0,.25,0],C.bark),cone(.32,.95,5,[0,.66,0],C.leaf)])
  return merge(p)
}
function oak(lod) {
  if(lod==='far') return merge([cyl(.05,.07,.5,5,[0,.25,0],C.bark),sphere(.38,0,[0,.65,0],C.leaf,[1.15,.8,1])])
  const d=lod==='near'?1:0
  const p=[cyl(.065,.09,.62,lod==='near'?9:6,[0,.31,0],C.bark),cyl(.03,.04,.38,6,[-.13,.55,0],C.bark,[0,0,-.58]),cyl(.03,.04,.34,6,[.14,.54,.02],C.bark,[0,0,.62]),sphere(.3,d,[-.2,.76,.02],C.leafDark,[1.1,.8,1]),sphere(.34,d,[.16,.8,-.04],C.leaf,[1.1,.9,1.05]),sphere(.25,d,[0,1.0,.03],C.leafLight,[1,.8,1])]
  return merge(p)
}
function house(lod) {
  if(lod==='far') return merge([box([.72,.4,.58],[0,.2,0],C.wall),cone(.52,.28,4,[0,.54,0],C.roof,[0,Math.PI/4,0])])
  const p=[box([.78,.42,.62],[0,.21,0],C.wall),cone(.55,.3,4,[0,.56,0],C.roof,[0,Math.PI/4,0]),box([.18,.3,.025],[-.2,.15,.323],C.dark),box([.22,.16,.025],[.2,.25,.323],C.glass),box([.06,.22,.06],[.25,.74,-.12],C.dark)]
  if(lod==='near'){p.push(box([.3,.035,.16],[.2,.48,.34],C.roof),box([.18,.025,.08],[-.2,.025,.39],0x766c54),cyl(.02,.02,.24,8,[.35,.12,.38],C.leafDark))}
  return merge(p)
}
function tower(lod) {
  if(lod==='far') return merge([box([.62,1.35,.56],[0,.675,0],C.concrete),box([.46,.2,.44],[0,1.45,0],C.dark)])
  const floors=lod==='near'?7:4, p=[box([.7,1.3,.62],[0,.65,0],C.concrete),box([.82,.16,.72],[0,.08,0],C.dark),box([.42,.18,.4],[0,1.39,0],C.dark)]
  for(let i=0;i<floors;i++){const y=.24+i*(.92/(floors-1));p.push(box([.58,.055,.012],[0,y,.317],i%2?C.glass:C.blue))}
  if(lod==='near'){p.push(cyl(.018,.018,.42,8,[0,1.69,0],C.accent),box([.12,.16,.02],[0,.16,.375],C.accent))}
  return merge(p)
}
function warehouse(lod) {
  if(lod==='far') return merge([box([.94,.44,.76],[0,.22,0],C.metal),box([1,.08,.82],[0,.48,0],C.dark)])
  const p=[box([.96,.44,.78],[0,.22,0],C.metal),box([1,.07,.84],[0,.475,0],C.dark),box([.3,.28,.025],[-.25,.16,.403],C.dark),box([.3,.28,.025],[.18,.16,.403],C.dark),box([.28,.05,.04],[-.25,.34,.42],C.accent)]
  if(lod==='near'){for(let i=-2;i<=2;i++)p.push(box([.13,.05,.6],[i*.19,.53,0],i%2?C.concrete:C.wall2,[0,0,i%2?.12:-.12]));p.push(box([.24,.14,.22],[.34,.07,-.48],C.red))}
  return merge(p)
}
function hipRoof(w, d, h, pos, color = C.roof) {
  return cone(Math.max(w, d) * 0.71, h, 4, pos, color, [0, Math.PI / 4, 0])
}
function civicDoor(x, y, z) {
  return box([.14, .26, .03], [x, y, z], C.dark)
}
function civicWindow(x, y, z, w = .16, h = .12) {
  return box([w, h, .025], [x, y, z], C.glass)
}
function civicChimney(x, y, z) {
  return box([.07, .2, .07], [x, y, z], C.wall2)
}

function facilityModel(lod, key) {
  switch (key) {
    case 'headquarters-small': return hqCampus(lod, 's')
    case 'headquarters-medium': return hqCampus(lod, 'm')
    case 'headquarters': return hqCampus(lod, 'l')
    case 'office-campus': return hqCampus(lod, 'office')
    case 'facility-small': return dcCampus(lod, 's')
    case 'facility-medium': return dcCampus(lod, 'm')
    case 'facility-large': return dcCampus(lod, 'l')
    case 'solar-field': return solarField(lod)
    case 'grid-substation': return substationYard(lod)
    case 'power-generation': return smrCampus(lod)
    case 'chip-fabrication': return fabCampus(lod)
    case 'cooling-campus': return coolingCampus(lod)
    case 'gas-generation': return gasCampus(lod)
    case 'battery-yard': return batteryYard(lod)
    case 'research-lab': return labCampus(lod)
    case 'training-centre': return trainingHall(lod)
    case 'network-operations': return networkOps(lod)
    case 'construction-shell': return constructionShell(lod)
    case 'utility-plant': return utilityPlant(lod)
    case 'security-centre': return securityCentre(lod)
    default: return dcCampus(lod, 's')
  }
}

function parapet(w, d, y, x = 0, z = 0, color = C.dark) {
  return box([w, .07, d], [x, y, z], color)
}
function canopy(w, d, y, x, z) {
  return box([w, .04, d], [x, y, z], C.trim)
}

/** Commercial office HQ — flat parapet, glass bands, canopy. Not a house. */
function hqCampus(lod, size) {
  if (size === 's') {
    if (lod === 'far') return merge([box([.9, .36, .62], [0, .18, 0], C.wall), parapet(.94, .66, .39)])
    const p = [
      box([.92, .38, .64], [0, .19, 0], C.wall),
      parapet(.96, .68, .41),
      box([.62, .18, .03], [.08, .22, .335], C.glass),
      civicDoor(-.32, .14, .335),
      canopy(.36, .16, .32, -.22, .42),
    ]
    if (lod === 'near') {
      p.push(box([.2, .1, .04], [.36, .28, .345], C.dark))
      p.push(box([.9, .03, .2], [0, .02, .42], C.concrete))
    }
    return merge(p)
  }
  if (size === 'm') {
    if (lod === 'far') return merge([
      box([.7, .62, .5], [-.2, .31, -.16], C.wall),
      box([.5, .62, .78], [.28, .31, .08], C.mass),
      parapet(.74, .54, .65, -.2, -.16),
    ])
    const p = [
      box([.72, .64, .52], [-.2, .32, -.16], C.wall),
      parapet(.76, .56, .67, -.2, -.16),
      box([.52, .64, .8], [.28, .32, .08], C.mass),
      parapet(.56, .84, .67, .28, .08),
      box([.5, .14, .03], [-.2, .48, .115], C.glass),
      box([.5, .14, .03], [-.2, .22, .115], C.glass),
      box([.03, .14, .48], [.555, .48, .08], C.glass),
      civicDoor(-.32, .14, .115),
      canopy(.32, .16, .32, -.28, .22),
    ]
    if (lod === 'near') {
      p.push(box([.18, .12, .04], [.28, .5, .495], C.dark))
      p.push(box([.28, .03, .28], [-.08, .02, .28], C.concrete))
    }
    return merge(p)
  }
  if (size === 'office') {
    if (lod === 'far') return merge([box([1.05, .36, .62], [0, .18, 0], C.wall), parapet(1.1, .66, .39)])
    const p = [
      box([1.08, .38, .64], [0, .19, 0], C.wall),
      parapet(1.12, .68, .41),
      box([.78, .16, .03], [.08, .22, .335], C.glass),
      civicDoor(-.4, .14, .335),
      canopy(.4, .16, .32, -.32, .42),
    ]
    if (lod === 'near') p.push(box([.22, .1, .04], [.42, .28, .345], C.dark))
    return merge(p)
  }
  if (lod === 'far') return merge([
    box([1.05, .32, .9], [0, .16, 0], C.mass),
    box([.7, .7, .55], [-.08, .67, -.08], C.wall),
    parapet(.74, .59, 1.05, -.08, -.08),
  ])
  const p = [
    box([1.08, .34, .92], [0, .17, 0], C.mass),
    parapet(1.12, .96, .37),
    box([.72, .72, .56], [-.08, .7, -.06], C.wall),
    parapet(.76, .6, 1.09, -.08, -.06),
    box([.42, .5, .7], [.42, .59, .12], C.wall2),
    parapet(.46, .74, .87, .42, .12),
    box([.56, .16, .03], [-.08, .86, .235], C.glass),
    box([.56, .16, .03], [-.08, .52, .235], C.glass),
    civicDoor(-.28, .14, .475),
    canopy(.4, .18, .32, -.2, .56),
  ]
  if (lod === 'near') {
    p.push(box([.24, .16, .06], [.42, .7, .5], C.dark))
    p.push(box([.2, .1, .2], [-.42, .39, .42], C.concrete))
    p.push(box([.16, .08, .16], [-.08, 1.16, -.06], C.metal))
  }
  return merge(p)
}

function dcCampus(lod, size) {
  if (size === 's') {
    if (lod === 'far') return merge([box([1.05, .4, .7], [0, .2, 0], C.wall), box([1.1, .08, .76], [0, .44, 0], C.roof)])
    const p = [
      box([1.08, .42, .72], [0, .21, 0], C.wall),
      box([1.14, .08, .78], [0, .46, 0], C.roof),
      box([.28, .22, .2], [-.42, .12, .4], C.wall2),
      box([.5, .1, .03], [.12, .26, .375], C.glass),
    ]
    if (lod === 'near') {
      p.push(box([.16, .1, .14], [-.22, .56, -.1], C.metal), box([.16, .1, .14], [.12, .56, -.1], C.metal))
      p.push(box([.2, .03, .16], [-.42, .03, .52], C.dark))
    }
    return merge(p)
  }
  if (size === 'm') {
    if (lod === 'far') return merge([
      box([.52, .48, .96], [-.28, .24, 0], C.wall),
      box([.52, .4, .8], [.3, .2, .04], C.mass),
    ])
    const p = [
      box([.54, .5, .98], [-.28, .25, 0], C.wall),
      box([.58, .08, 1.04], [-.28, .54, 0], C.roof),
      box([.54, .42, .82], [.32, .21, .04], C.mass),
      box([.58, .08, .88], [.32, .46, .04], C.trim),
      box([.36, .12, .03], [-.28, .28, .505], C.glass),
    ]
    if (lod === 'near') {
      for (let i = 0; i < 3; i++) p.push(box([.14, .1, .14], [-.42 + i * .18, .64, -.2], C.metal))
      p.push(box([.24, .2, .16], [.32, .12, .5], C.wall2))
    }
    return merge(p)
  }
  if (lod === 'far') return merge([
    box([.7, .52, 1.05], [-.22, .26, 0], C.mass),
    box([.48, .72, .48], [.38, .36, .16], C.concrete),
  ])
  const p = [
    box([.72, .54, 1.08], [-.22, .27, 0], C.mass),
    box([.76, .08, 1.14], [-.22, .58, 0], C.roof),
    box([.5, .42, .7], [.4, .21, -.22], C.wall),
    box([.54, .08, .76], [.4, .46, -.22], C.trim),
    box([.36, .78, .36], [.42, .39, .32], C.concrete),
    box([.4, .08, .4], [.42, .82, .32], C.dark),
    box([.48, .12, .03], [-.22, .3, .555], C.glass),
  ]
  if (lod === 'near') {
    for (let i = 0; i < 4; i++) p.push(box([.14, .1, .14], [-.48 + i * .2, .68, -.28], C.metal))
    p.push(box([.28, .22, .18], [-.5, .12, .58], C.wall2))
  }
  return merge(p)
}

function solarField(lod) {
  const p = [box([1.35, .05, 1.1], [0, .025, 0], C.dark), box([.28, .22, .22], [-.48, .12, .4], C.wall)]
  const rows = lod === 'near' ? 3 : lod === 'mid' ? 2 : 1
  for (let r = 0; r < rows; r++) {
    const z = (r - (rows - 1) / 2) * .34
    p.push(box([1.05, .035, .25], [.08, .23, z], C.panel, [-.28, 0, 0]))
    if (lod !== 'far') for (let x = -1; x <= 1; x++) p.push(box([.04, .16, .04], [x * .42 + .08, .08, z], C.metal))
  }
  if (lod === 'near') p.push(box([.12, .1, .03], [-.48, .16, .52], C.dark), box([.18, .04, .18], [-.48, .25, .4], C.roof))
  return merge(p)
}

function substationYard(lod) {
  const p = [box([1.2, .05, 1.05], [0, .025, 0], C.dark), box([.36, .28, .32], [-.38, .16, .32], C.wall)]
  if (lod === 'far') return merge([...p, box([.22, .32, .18], [.2, .18, -.1], C.metal)])
  for (const x of [-.18, .12, .42]) p.push(box([.2, .26, .16], [x, .16, -.18], C.metal))
  for (const x of [-.5, 0, .5]) p.push(box([.05, .42, .05], [x, .24, .46], C.concrete))
  if (lod === 'near') {
    p.push(box([1.05, .04, .04], [0, .42, .46], C.metal), box([.14, .08, .03], [-.38, .18, .49], C.dark))
    p.push(hipRoof(.38, .34, .14, [-.38, .36, .32]))
  }
  return merge(p)
}

function smrCampus(lod) {
  if (lod === 'far') return merge([
    box([.7, .62, .7], [.18, .31, .08], C.mass),
    box([.28, .72, .28], [-.38, .36, -.22], C.concrete),
  ])
  const p = [
    box([.74, .64, .74], [.2, .32, .1], C.mass),
    box([.78, .08, .78], [.2, .68, .1], C.concrete),
    box([.3, .78, .3], [-.4, .39, -.24], C.concrete),
    box([.3, .7, .3], [-.08, .35, -.28], C.concrete),
    box([.48, .36, .34], [.38, .18, -.38], C.wall),
    box([.52, .08, .38], [.38, .4, -.38], C.roof),
  ]
  if (lod === 'near') {
    p.push(box([.16, .08, .16], [.2, .76, .1], C.dark), box([.12, .18, .03], [.38, .18, -.2], C.dark))
    p.push(box([.18, .06, .18], [-.4, .82, -.24], C.metal), box([.18, .06, .18], [-.08, .74, -.28], C.metal))
  }
  return merge(p)
}

function fabCampus(lod) {
  if (lod === 'far') return merge([box([1.2, .4, .72], [0, .2, 0], C.wall), box([.5, .22, .5], [.2, .5, 0], C.mass)])
  const p = [
    box([1.22, .42, .74], [0, .21, 0], C.wall),
    box([1.28, .08, .8], [0, .46, 0], C.roof),
    box([.52, .24, .52], [.18, .56, 0], C.mass),
    box([.56, .06, .56], [.18, .7, 0], C.concrete),
    box([.7, .12, .03], [-.16, .26, .385], C.glass),
  ]
  if (lod === 'near') {
    p.push(box([.36, .28, .22], [-.48, .16, .42], C.wall2), box([.14, .1, .14], [-.3, .56, -.16], C.metal))
    p.push(box([.14, .1, .14], [0, .56, -.16], C.metal))
  }
  return merge(p)
}

function coolingCampus(lod) {
  const p = [box([1.15, .05, .95], [0, .025, 0], C.dark), box([.32, .26, .28], [.42, .14, .32], C.wall)]
  for (const x of [-.38, 0, .38]) {
    p.push(box([.28, .52, .28], [x, .28, -.12], C.concrete))
    p.push(box([.3, .06, .3], [x, .56, -.12], C.metal))
  }
  if (lod === 'far') return merge(p)
  p.push(box([.9, .06, .08], [0, .1, .18], C.metal))
  if (lod === 'near') p.push(hipRoof(.34, .3, .12, [.42, .32, .32]), box([.1, .1, .03], [.42, .14, .47], C.dark))
  return merge(p)
}

function gasCampus(lod) {
  const p = [
    box([.7, .38, .52], [-.28, .19, .16], C.wall),
    box([.74, .08, .56], [-.28, .42, .16], C.roof),
    box([.28, .32, .28], [.32, .16, -.16], C.metal),
    box([.28, .26, .28], [.32, .13, .22], C.dark),
  ]
  if (lod === 'far') return merge(p)
  p.push(box([.1, .58, .1], [.32, .42, -.16], C.concrete), civicDoor(-.28, .14, .435))
  if (lod === 'near') {
    p.push(box([.16, .1, .03], [-.08, .24, .435], C.glass), box([.12, .08, .12], [.32, .48, .22], C.metal))
    p.push(civicChimney(-.5, .56, .16))
  }
  return merge(p)
}

function batteryYard(lod) {
  const p = [box([1.2, .05, 1.0], [0, .025, 0], C.dark)]
  const cols = lod === 'far' ? 2 : 3
  const rows = lod === 'far' ? 1 : 2
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    p.push(box([.22, .24, .28], [-.4 + col * .32, .14, -.22 + row * .4], C.metal))
  }
  p.push(box([.28, .22, .22], [.46, .12, .36], C.wall))
  if (lod === 'near') p.push(box([.18, .04, .18], [.46, .25, .36], C.roof), box([.08, .04, .04], [-.4, .28, -.06], C.accent))
  return merge(p)
}

function labCampus(lod) {
  if (lod === 'far') return merge([
    box([.9, .42, .62], [-.08, .21, 0], C.wall),
    box([.42, .32, .42], [.4, .16, .22], C.mass),
    parapet(.94, .66, .45, -.08, 0),
  ])
  const p = [
    box([.92, .44, .64], [-.08, .22, 0], C.wall),
    parapet(.96, .68, .47, -.08, 0),
    box([.44, .34, .44], [.42, .17, .22], C.mass),
    parapet(.48, .48, .37, .42, .22),
    civicDoor(-.2, .14, .335),
    box([.56, .16, .03], [.08, .28, .335], C.glass),
    canopy(.32, .14, .3, -.16, .42),
  ]
  if (lod === 'near') {
    p.push(box([.18, .08, .18], [-.08, .56, 0], C.metal))
    p.push(civicWindow(.42, .22, .455, .16, .12))
  }
  return merge(p)
}

function trainingHall(lod) {
  if (lod === 'far') return merge([box([1.1, .36, .62], [0, .18, 0], C.wall), parapet(1.14, .66, .39)])
  const p = [
    box([1.12, .38, .64], [0, .19, 0], C.wall),
    parapet(1.16, .68, .41),
    civicDoor(-.36, .14, .335),
    box([.78, .14, .03], [.12, .24, .335], C.glass),
    canopy(.36, .14, .3, -.28, .42),
  ]
  if (lod === 'near') p.push(box([.16, .08, .16], [.36, .48, -.1], C.metal))
  return merge(p)
}

function networkOps(lod) {
  const p = [
    box([.7, .36, .58], [0, .18, .08], C.wall),
    parapet(.74, .62, .39, 0, .08),
    box([.36, .08, .36], [0, .48, .08], C.metal),
    box([.28, .04, .28], [0, .54, .08], C.mass),
  ]
  if (lod === 'far') return merge(p)
  p.push(civicDoor(0, .14, .385), box([.2, .42, .08], [.28, .36, -.28], C.concrete))
  if (lod === 'near') p.push(box([.32, .12, .03], [-.08, .24, .385], C.glass), box([.12, .12, .12], [.28, .62, -.28], C.metal))
  return merge(p)
}

function constructionShell(lod) {
  const p = [
    box([1.05, .08, .9], [0, .04, 0], C.concrete),
    box([.08, .46, .08], [-.44, .29, -.36], C.trim),
    box([.08, .46, .08], [.44, .29, -.36], C.trim),
    box([.08, .46, .08], [-.44, .29, .36], C.trim),
    box([.08, .46, .08], [.44, .29, .36], C.trim),
  ]
  if (lod === 'far') return merge(p)
  p.push(box([.96, .06, .06], [0, .5, -.36], C.wall2), box([.96, .06, .06], [0, .5, .36], C.wall2))
  if (lod === 'near') {
    p.push(box([.06, .06, .78], [-.44, .5, 0], C.wall2), box([.06, .06, .78], [.44, .5, 0], C.wall2))
    p.push(box([.3, .22, .24], [-.1, .15, .1], C.wall))
  }
  return merge(p)
}

function utilityPlant(lod) {
  const p = [
    box([.55, .34, .48], [-.28, .17, .1], C.wall),
    box([.58, .08, .52], [-.28, .38, .1], C.roof),
    box([.3, .28, .3], [.3, .14, -.16], C.metal),
    box([.3, .22, .3], [.3, .11, .22], C.dark),
  ]
  if (lod === 'far') return merge(p)
  p.push(box([.1, .48, .1], [.3, .38, -.16], C.concrete), civicDoor(-.28, .14, .355))
  if (lod === 'near') p.push(box([.16, .08, .03], [-.1, .22, .355], C.glass), civicChimney(-.46, .52, .1))
  return merge(p)
}

function securityCentre(lod) {
  const p = [
    box([.72, .36, .56], [0, .18, 0], C.wall),
    parapet(.76, .6, .39),
    box([.08, .28, .08], [-.42, .14, .34], C.dark),
    box([.08, .28, .08], [.42, .14, .34], C.dark),
  ]
  if (lod === 'far') return merge(p)
  p.push(civicDoor(0, .14, .295), box([.5, .04, .04], [0, .26, .34], C.metal), canopy(.28, .12, .3, 0, .38))
  if (lod === 'near') p.push(box([.4, .12, .03], [0, .24, .295], C.glass))
  return merge(p)
}

/** Build the same descriptor-driven campus silhouettes used by runtime fallbacks. */
function municipalCampus(campus, lod) {
  const parts = []
  for (const structure of campus.structures) {
    const [x, y, z] = structure.position
    const [sx, sy, sz] = structure.scale
    const color = structure.color
    if (structure.shape === 'box') parts.push(box([sx, sy, sz], [x, y, z], color))
    else if (structure.shape === 'cylinder') parts.push(cyl(sx, sx * .84, sy, lod === 'near' ? 12 : 7, [x, y, z], color))
    else if (structure.shape === 'sphere') parts.push(sphere(.5, lod === 'near' ? 1 : 0, [x, y, z], color, [sx * 2, sy * 2, sz * 2]))
    else if (structure.shape === 'coolingTower') {
      parts.push(cyl(sx * .72, sx, sy, lod === 'near' ? 16 : lod === 'mid' ? 10 : 7, [x, y, z], color))
      if (lod === 'near') parts.push(cyl(sx, sx * .72, sy * .3, 16, [x, y + sy * .36, z], color))
    } else if (structure.shape === 'solarCluster') {
      // Panels are emitted as one merged geometry per LOD, never per-panel meshes.
      const rows = lod === 'near' ? 4 : lod === 'mid' ? 3 : 2
      const columns = lod === 'near' ? 4 : lod === 'mid' ? 3 : 2
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        const px = x + (column - (columns - 1) / 2) * sx / columns
        const pz = z + (row - (rows - 1) / 2) * sz / rows
        parts.push(box([sx / columns * .82, .025, sz / rows * .62], [px, y, pz], color, [-.24, 0, 0]))
      }
    }
  }
  const result = merge(parts)
  result.userData = { municipalKind: campus.kind, solarClusterMerged: campus.kind === 'solar' }
  return result
}
function bus(lod) {
  if(lod==='far') return merge([box([.72,.26,.28],[0,.2,0],C.red)])
  const p=[box([.78,.28,.3],[0,.22,0],C.red),box([.58,.14,.012],[0,.28,.156],C.glass),box([.12,.16,.012],[.32,.22,.156],C.dark),cyl(.065,.065,.045,lod==='near'?10:6,[-.25,.09,.165],C.dark,[Math.PI/2,0,0]),cyl(.065,.065,.045,lod==='near'?10:6,[.25,.09,.165],C.dark,[Math.PI/2,0,0])]
  if(lod==='near')p.push(box([.5,.025,.31],[-.05,.38,0],C.wall))
  return merge(p)
}
function boat(lod) {
  const p=[part(new THREE.ConeGeometry(.32,.88,lod==='near'?10:6),C.watercraft,[0,.12,0],[0,0,Math.PI/2],[1,.42,1]),box([.42,.18,.3],[.02,.24,0],C.wall),box([.28,.11,.025],[.02,.29,.156],C.glass)]
  if(lod!=='far')p.push(cyl(.018,.018,.58,8,[.05,.59,0],C.dark),box([.02,.34,.28],[.05,.55,-.13],C.wall2,[0,0,.12]))
  return merge(p)
}
function ducks(lod) {
  const duck=(x,z,s)=>[sphere(.1*s,0,[x,.11*s,z],C.bark,[1.35,.75,1]),sphere(.065*s,0,[x+.1*s,.18*s,z],0x3f6d4a,[1,.9,1]),cone(.045*s,.1*s,4,[x+.17*s,.17*s,z],C.accent,[0,0,-Math.PI/2])]
  return merge(lod==='far'?duck(0,0,1):[...duck(-.12,.03,1),...duck(.18,-.07,.78)])
}
function roadLamp(lod) {
  const p=[cyl(.025,.035,.68,lod==='near'?10:6,[0,.34,0],C.dark),box([.24,.025,.025],[.1,.67,0],C.dark),box([.1,.06,.08],[.22,.63,0],C.wall)]
  if(lod==='near')p.push(cyl(.065,.09,.04,10,[0,.02,0],C.metal))
  return merge(p)
}
function trafficLight(lod) {
  const sides = lod === 'near' ? 10 : 6
  if (lod === 'far') return merge([cyl(.025,.035,.62,6,[0,.31,0],C.dark),box([.1,.23,.1],[0,.59,0],C.dark)])
  const p=[cyl(.025,.04,.68,sides,[0,.34,0],C.dark),box([.13,.3,.12],[0,.66,0],C.dark)]
  const lights=lod==='near'?[[.75,C.red],[.66,C.accent],[.57,0x4d9a55]]:[[.7,C.red]]
  for(const [y,color] of lights)p.push(cyl(.032,.032,.014,8,[.067,y,0],color,[0,0,Math.PI/2]))
  if(lod==='near')p.push(cyl(.065,.09,.04,10,[0,.02,0],C.metal))
  return merge(p)
}
function pedestrianSignal(lod) {
  const p=[cyl(.022,.032,.48,lod==='near'?10:6,[0,.24,0],C.dark),box([.14,.18,.1],[0,.49,0],C.dark)]
  if(lod!=='far')p.push(box([.055,.09,.012],[.071,.5,0],lod==='near'?0xe9eee0:C.wall))
  if(lod==='near')p.push(cyl(.035,.035,.018,8,[.072,.39,0],C.accent,[0,0,Math.PI/2]))
  return merge(p)
}
function roadSign(lod) {
  const p=[cyl(.018,.026,.54,lod==='near'?10:6,[0,.27,0],C.metal),box([.32,.22,.035],[0,.53,0],C.blue)]
  if(lod==='near')p.push(box([.21,.025,.01],[0,.56,.023],C.wall),box([.13,.025,.01],[0,.5,.023],C.wall))
  return merge(p)
}
function highwayGuardrail(lod) {
  if(lod==='far') return merge([box([.88,.07,.045],[0,.18,0],C.metal)])
  const p=[box([.92,.075,.05],[0,.23,0],C.metal),box([.92,.035,.04],[0,.13,0],C.dark)]
  for(const x of [-.4,0,.4])p.push(box([.035,.28,.035],[x,.14,0],C.dark))
  if(lod==='near')p.push(box([.92,.025,.015],[0,.255,.033],C.wall))
  return merge(p)
}
function roadProp(lod, index) {
  if(index===0)return roadLamp(lod)
  if(index===3)return trafficLight(lod)
  if(index===4)return pedestrianSignal(lod)
  if(index===5)return roadSign(lod)
  if(index===10)return highwayGuardrail(lod)
  return bench(lod)
}
function bench(lod) {
  const p=[box([.62,.07,.16],[0,.24,-.07],C.bark),box([.62,.22,.055],[0,.38,-.18],C.bark),box([.055,.25,.055],[-.24,.125,0],C.dark),box([.055,.25,.055],[.24,.125,0],C.dark)]
  if(lod==='near')p.push(box([.66,.025,.045],[0,.49,-.2],C.metal))
  return merge(p)
}

await mkdir(outputDir, { recursive: true })
for (const file of await readdir(outputDir)) {
  if (/^[a-z]+\.[a-f0-9]{12}\.glb$/.test(file)) await unlink(path.join(outputDir, file))
}
const bundles = []
for (const family of [...new Set(definitions.map(entry => entry.family))]) {
  const scene = new THREE.Scene()
  scene.name = `${family}-bundle`
  for (const entry of definitions.filter(item => item.family === family)) {
    for (const lod of ['near', 'mid', 'far']) {
      const mesh = new THREE.Mesh(entry.build(lod), whiteMaterial)
      mesh.name = `${entry.key}__${lod}`
      scene.add(mesh)
    }
  }
  const data = await new Promise((resolve, reject) => new GLTFExporter().parse(scene, resolve, reject, {
    binary: true, onlyVisible: false, trs: false,
  }))
  const bytes = Buffer.from(data)
  const file = `${family}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.glb`
  await writeFile(path.join(outputDir, file), bytes)
  bundles.push({ family, url: `/assets/world-v4/${file}`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}

const manifest = {
  version: 1,
  generatedBy: 'scripts/generate-world-models.mjs',
  coordinateSystem: { up: '+Y', forward: '+X', ground: 0, tileSize: 1 },
  bundles,
  models: definitions.map(({ build: _build, ...entry }) => ({
    ...entry,
    nodes: { near: `${entry.key}__near`, mid: `${entry.key}__mid`, far: `${entry.key}__far` },
    fallbackKey: entry.key,
  })),
}
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Exported ${definitions.length} models across ${bundles.length} deterministic GLB bundles to ${outputDir}`)
