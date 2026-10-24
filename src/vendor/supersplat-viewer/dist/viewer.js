import { AppBase, AppOptions, CameraComponentSystem, LightComponentSystem, RenderComponentSystem, GSplatComponentSystem, ScriptComponentSystem, ContainerHandler, TextureHandler, GSplatHandler, BinaryHandler, XrManager, Asset, SEMANTIC_POSITION, INDEXFORMAT_UINT32, Vec3, PROJECTION_PERSPECTIVE, math, Script, Entity, Mat4, version as version$1, Quat, Pose, OrbitController as OrbitController$1, Vec2, ShaderUtils, Texture, ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR, PIXELFORMAT_RGBA8, RenderTarget, ASPECT_AUTO, BlendState, drawQuadWithShader, Vec4, Color, PROJECTION_ORTHOGRAPHIC, ShaderChunks, FILTER_NEAREST, PIXELFORMAT_RGBA16F, RenderPassPicker, BLENDEQUATION_MIN, BLENDMODE_ONE, ShaderMaterial, CULLFACE_NONE, BLEND_NONE, Mesh, PRIMITIVE_TRISTRIP, GraphNode, MeshInstance, PIXELFORMAT_R32F, PIXELFORMAT_R16F, GamepadSource, KeyboardMouseSource, MultiTouchSource, InputFrame, PRIMITIVE_TRIANGLES, Layer, SORTMODE_MANUAL, CULLFACE_BACK, BLEND_NORMAL, FUNC_EQUAL, StandardMaterial, FUNC_LESSEQUAL, RENDERSTYLE_WIREFRAME, PIXELFORMAT_RGBA32F, SAMPLETYPE_UNFILTERABLE_FLOAT, SHADERLANGUAGE_WGSL, Frustum, BoundingSphere, StorageBuffer, BUFFERUSAGE_COPY_DST, Compute, BUFFERUSAGE_COPY_SRC, BindGroupFormat, BindStorageBufferFormat, BindUniformBufferFormat, SHADERSTAGE_COMPUTE, Shader, UniformBufferFormat, UniformFormat, UNIFORMTYPE_UINT, BindTextureFormat, TEXTUREDIMENSION_2D, SAMPLETYPE_DEPTH, PIXELFORMAT_DEPTH, PIXELFORMAT_RGBA16U, PIXELFORMAT_R32U, BLEND_PREMULTIPLIED, Camera as Camera$1, UNIFORMTYPE_MAT4, UNIFORMTYPE_VEC4, UNIFORMTYPE_VEC2, UNIFORMTYPE_FLOAT, RenderPass, SHADER_FORWARD, BindStorageTextureFormat, DEVICETYPE_WEBGL2, platform, BoundingBox, GSPLAT_DEBUG_LOD, GSPLAT_DEBUG_NONE, MiniStats, CameraFrame, TONEMAP_NEUTRAL, TONEMAP_ACES2, TONEMAP_ACES, TONEMAP_HEJL, TONEMAP_FILMIC, TONEMAP_LINEAR, TONEMAP_NONE, LAYERID_SKYBOX, GSPLAT_RENDERER_RASTER_GPU_SORT, GSPLAT_RENDERER_RASTER_CPU_SORT, revision, EventHandler, createGraphicsDevice, Keyboard, TouchDevice as TouchDevice$1, Mouse } from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr/xr-controllers.mjs';
import { XrManipulation } from 'playcanvas/scripts/esm/xr/xr-manipulation.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr/xr-navigation.mjs';

class App extends AppBase {
    constructor(canvas, options) {
        super(canvas);
        const appOptions = new AppOptions();
        appOptions.graphicsDevice = options.graphicsDevice;
        appOptions.componentSystems = [
            CameraComponentSystem,
            LightComponentSystem,
            RenderComponentSystem,
            GSplatComponentSystem,
            ScriptComponentSystem
        ];
        appOptions.resourceHandlers = [ContainerHandler, TextureHandler, GSplatHandler, BinaryHandler];
        appOptions.mouse = options.mouse;
        appOptions.touch = options.touch;
        appOptions.keyboard = options.keyboard;
        appOptions.xr = XrManager;
        this.init(appOptions);
    }
}

/**
 * Fallback voxel cell size for mesh collision, which doesn't carry the carve
 * metadata itself. Assumes the mesh was generated from a voxel grid at this
 * resolution (matches the default `splat-transform --voxel-carve` output).
 */
const DEFAULT_VOXEL_RESOLUTION = 0.05;
/** Minimum penetration depth to report (avoids floating-point noise) */
const PENETRATION_EPSILON = 1e-4;
/** Maximum iterations for iterative sphere/capsule resolution */
const MAX_RESOLVE_ITERATIONS = 4;
/**
 * Iteratively resolve penetrations by repeatedly querying the deepest overlap,
 * projecting against previous constraint normals, and accumulating the push-out.
 * Shared by both MeshCollision and VoxelCollision for sphere and capsule queries.
 *
 * @param cx - Initial query center X.
 * @param cy - Initial query center Y.
 * @param cz - Initial query center Z.
 * @param findPenetration - Callback that finds the deepest penetration from (cx, cy, cz)
 * and writes the push vector into `scratch`. Returns true if a penetration was found.
 * @param constraintNormals - Pre-allocated array of at least 3 normal vectors (mutated).
 * @param scratch - Pre-allocated PushOut for the callback to write into (mutated).
 * @param out - Receives the total accumulated push-out vector on success.
 * @returns True if a meaningful push-out was computed.
 */
function resolveIterative(cx, cy, cz, findPenetration, constraintNormals, scratch, out) {
    let resolvedX = cx;
    let resolvedY = cy;
    let resolvedZ = cz;
    let totalPushX = 0;
    let totalPushY = 0;
    let totalPushZ = 0;
    let hadCollision = false;
    let numNormals = 0;
    for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
        if (!findPenetration(resolvedX, resolvedY, resolvedZ, scratch))
            break;
        hadCollision = true;
        let px = scratch.x;
        let py = scratch.y;
        let pz = scratch.z;
        for (let i = 0; i < numNormals; i++) {
            const n = constraintNormals[i];
            const dot = px * n.x + py * n.y + pz * n.z;
            if (dot < 0) {
                px -= dot * n.x;
                py -= dot * n.y;
                pz -= dot * n.z;
            }
        }
        const len = Math.sqrt(scratch.x * scratch.x + scratch.y * scratch.y + scratch.z * scratch.z);
        if (len > PENETRATION_EPSILON && numNormals < 3) {
            const invLen = 1.0 / len;
            const n = constraintNormals[numNormals];
            n.x = scratch.x * invLen;
            n.y = scratch.y * invLen;
            n.z = scratch.z * invLen;
            numNormals++;
        }
        resolvedX += px;
        resolvedY += py;
        resolvedZ += pz;
        totalPushX += px;
        totalPushY += py;
        totalPushZ += pz;
    }
    const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
    const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;
    if (hasSignificantPush) {
        out.x = totalPushX;
        out.y = totalPushY;
        out.z = totalPushZ;
    }
    return hasSignificantPush;
}

// ---- BVH construction ----
const MAX_LEAF_TRIS = 4;
function computeTriangleBounds(tris, idx, out) {
    const i = tris.indices[idx];
    out.minX = Math.min(tris.v0x[i], tris.v1x[i], tris.v2x[i]);
    out.minY = Math.min(tris.v0y[i], tris.v1y[i], tris.v2y[i]);
    out.minZ = Math.min(tris.v0z[i], tris.v1z[i], tris.v2z[i]);
    out.maxX = Math.max(tris.v0x[i], tris.v1x[i], tris.v2x[i]);
    out.maxY = Math.max(tris.v0y[i], tris.v1y[i], tris.v2y[i]);
    out.maxZ = Math.max(tris.v0z[i], tris.v1z[i], tris.v2z[i]);
}
function buildBVH(tris, start, count) {
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    };
    const tb = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    for (let i = start; i < start + count; i++) {
        computeTriangleBounds(tris, i, tb);
        bounds.minX = Math.min(bounds.minX, tb.minX);
        bounds.minY = Math.min(bounds.minY, tb.minY);
        bounds.minZ = Math.min(bounds.minZ, tb.minZ);
        bounds.maxX = Math.max(bounds.maxX, tb.maxX);
        bounds.maxY = Math.max(bounds.maxY, tb.maxY);
        bounds.maxZ = Math.max(bounds.maxZ, tb.maxZ);
    }
    if (count <= MAX_LEAF_TRIS) {
        return {
            ...bounds,
            left: null,
            right: null,
            triStart: start,
            triCount: count
        };
    }
    // Split along longest axis using midpoint
    const dx = bounds.maxX - bounds.minX;
    const dy = bounds.maxY - bounds.minY;
    const dz = bounds.maxZ - bounds.minZ;
    const axis = dx >= dy && dx >= dz ? 0 : dy >= dz ? 1 : 2;
    const mid = axis === 0
        ? (bounds.minX + bounds.maxX) * 0.5
        : axis === 1
            ? (bounds.minY + bounds.maxY) * 0.5
            : (bounds.minZ + bounds.maxZ) * 0.5;
    // Partition indices[start..start+count) around the midpoint
    let left = start;
    let right = start + count - 1;
    while (left <= right) {
        const i = tris.indices[left];
        const cx = axis === 0
            ? (tris.v0x[i] + tris.v1x[i] + tris.v2x[i]) / 3
            : axis === 1
                ? (tris.v0y[i] + tris.v1y[i] + tris.v2y[i]) / 3
                : (tris.v0z[i] + tris.v1z[i] + tris.v2z[i]) / 3;
        if (cx < mid) {
            left++;
        }
        else {
            const tmp = tris.indices[left];
            tris.indices[left] = tris.indices[right];
            tris.indices[right] = tmp;
            right--;
        }
    }
    // Fall back to median split when midpoint produces a degenerate partition
    let leftCount = left - start;
    if (leftCount === 0 || leftCount === count)
        leftCount = count >> 1;
    return {
        ...bounds,
        left: buildBVH(tris, start, leftCount),
        right: buildBVH(tris, start + leftCount, count - leftCount),
        triStart: 0,
        triCount: 0
    };
}
// ---- Ray-AABB intersection ----
function rayAABB(ox, oy, oz, idx, idy, idz, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
    const t1x = (minX - ox) * idx;
    const t2x = (maxX - ox) * idx;
    const t1y = (minY - oy) * idy;
    const t2y = (maxY - oy) * idy;
    const t1z = (minZ - oz) * idz;
    const t2z = (maxZ - oz) * idz;
    const tmin = Math.max(Math.min(t1x, t2x), Math.min(t1y, t2y), Math.min(t1z, t2z));
    const tmax = Math.min(Math.max(t1x, t2x), Math.max(t1y, t2y), Math.max(t1z, t2z));
    if (tmax < 0 || tmin > tmax || tmin > maxDist)
        return -1;
    return tmin >= 0 ? tmin : 0;
}
// ---- Moller-Trumbore ray-triangle ----
function rayTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-10)
        return -1;
    const invDet = 1.0 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1)
        return -1;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * invDet;
    if (v < 0 || u + v > 1)
        return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return t >= 0 ? t : -1;
}
// ---- Sphere-AABB overlap test ----
function sphereAABBOverlap(cx, cy, cz, radius, minX, minY, minZ, maxX, maxY, maxZ) {
    const nx = Math.max(minX, Math.min(cx, maxX));
    const ny = Math.max(minY, Math.min(cy, maxY));
    const nz = Math.max(minZ, Math.min(cz, maxZ));
    const dx = cx - nx, dy = cy - ny, dz = cz - nz;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
}
// ---- Closest point on triangle to a point ----
function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) {
        out.x = ax;
        out.y = ay;
        out.z = az;
        return;
    }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
        out.x = bx;
        out.y = by;
        out.z = bz;
        return;
    }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.x = ax + abx * v;
        out.y = ay + aby * v;
        out.z = az + abz * v;
        return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) {
        out.x = cx;
        out.y = cy;
        out.z = cz;
        return;
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out.x = ax + acx * w;
        out.y = ay + acy * w;
        out.z = az + acz * w;
        return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        out.x = bx + (cx - bx) * w;
        out.y = by + (cy - by) * w;
        out.z = bz + (cz - bz) * w;
        return;
    }
    const denom = 1.0 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    out.x = ax + abx * v + acx * w;
    out.y = ay + aby * v + acy * w;
    out.z = az + abz * v + acz * w;
}
// ---- Closest point on a line segment to a point ----
function closestPointOnSegment(px, py, pz, ax, ay, az, bx, by, bz, out) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const lenSq = abx * abx + aby * aby + abz * abz;
    if (lenSq < 1e-20) {
        out.x = ax;
        out.y = ay;
        out.z = az;
        return;
    }
    const apx = px - ax, apy = py - ay, apz = pz - az;
    let t = (apx * abx + apy * aby + apz * abz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    out.x = ax + abx * t;
    out.y = ay + aby * t;
    out.z = az + abz * t;
}
// ---- Closest point on segment to triangle (returns distance squared) ----
const _segPt = { x: 0, y: 0, z: 0 };
const _triPt = { x: 0, y: 0, z: 0 };
const _tmpSegPt = { x: 0, y: 0, z: 0 };
const _tmpTriPt = { x: 0, y: 0, z: 0 };
// Approximate closest points between a line segment and a triangle.
// Uses discrete sampling (6 points along the segment) followed by one
// refinement pass. Sufficient for vertical capsule collision (walk/fly mode)
// where the segment is always Y-aligned and triangles are near-axis-aligned.
function closestSegmentTriangle(s0x, s0y, s0z, s1x, s1y, s1z, ax, ay, az, bx, by, bz, cx, cy, cz, outSeg, outTri) {
    const SAMPLES = 5;
    let bestDistSq = Infinity;
    for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        const sx = s0x + (s1x - s0x) * t;
        const sy = s0y + (s1y - s0y) * t;
        const sz = s0z + (s1z - s0z) * t;
        closestPointOnTriangle(sx, sy, sz, ax, ay, az, bx, by, bz, cx, cy, cz, _tmpTriPt);
        const dx = sx - _tmpTriPt.x, dy = sy - _tmpTriPt.y, dz = sz - _tmpTriPt.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < bestDistSq) {
            bestDistSq = distSq;
            _segPt.x = sx;
            _segPt.y = sy;
            _segPt.z = sz;
            _triPt.x = _tmpTriPt.x;
            _triPt.y = _tmpTriPt.y;
            _triPt.z = _tmpTriPt.z;
        }
    }
    // Refine: find closest point on segment to the best triangle point, then re-test
    closestPointOnSegment(_triPt.x, _triPt.y, _triPt.z, s0x, s0y, s0z, s1x, s1y, s1z, _tmpSegPt);
    closestPointOnTriangle(_tmpSegPt.x, _tmpSegPt.y, _tmpSegPt.z, ax, ay, az, bx, by, bz, cx, cy, cz, _tmpTriPt);
    const dx = _tmpSegPt.x - _tmpTriPt.x;
    const dy = _tmpSegPt.y - _tmpTriPt.y;
    const dz = _tmpSegPt.z - _tmpTriPt.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
        bestDistSq = distSq;
        _segPt.x = _tmpSegPt.x;
        _segPt.y = _tmpSegPt.y;
        _segPt.z = _tmpSegPt.z;
        _triPt.x = _tmpTriPt.x;
        _triPt.y = _tmpTriPt.y;
        _triPt.z = _tmpTriPt.z;
    }
    outSeg.x = _segPt.x;
    outSeg.y = _segPt.y;
    outSeg.z = _segPt.z;
    outTri.x = _triPt.x;
    outTri.y = _triPt.y;
    outTri.z = _triPt.z;
    return bestDistSq;
}
// ---- MeshCollision ----
const _closest = { x: 0, y: 0, z: 0 };
const _segClosest = { x: 0, y: 0, z: 0 };
const _triClosest = { x: 0, y: 0, z: 0 };
class MeshCollision {
    /**
     * Assumed voxel resolution of the source carve that produced this mesh.
     * The mesh itself doesn't carry this metadata, so we fall back to the
     * default; can be overridden post-construction if a loader knows better.
     */
    voxelResolution = DEFAULT_VOXEL_RESOLUTION;
    _tris;
    _root;
    _normalResult = { nx: 0, ny: 0, nz: 0 };
    _push = { x: 0, y: 0, z: 0 };
    _constraintNormals = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];
    _stack = [];
    _rayResult = { t: -1, triIdx: -1 };
    constructor(positions, indices) {
        const numTris = Math.floor(indices.length / 3);
        const tris = {
            v0x: new Float32Array(numTris),
            v0y: new Float32Array(numTris),
            v0z: new Float32Array(numTris),
            v1x: new Float32Array(numTris),
            v1y: new Float32Array(numTris),
            v1z: new Float32Array(numTris),
            v2x: new Float32Array(numTris),
            v2y: new Float32Array(numTris),
            v2z: new Float32Array(numTris),
            nx: new Float32Array(numTris),
            ny: new Float32Array(numTris),
            nz: new Float32Array(numTris),
            indices: new Uint32Array(numTris),
            count: numTris
        };
        for (let i = 0; i < numTris; i++) {
            const i0 = indices[i * 3] * 3;
            const i1 = indices[i * 3 + 1] * 3;
            const i2 = indices[i * 3 + 2] * 3;
            tris.v0x[i] = positions[i0];
            tris.v0y[i] = positions[i0 + 1];
            tris.v0z[i] = positions[i0 + 2];
            tris.v1x[i] = positions[i1];
            tris.v1y[i] = positions[i1 + 1];
            tris.v1z[i] = positions[i1 + 2];
            tris.v2x[i] = positions[i2];
            tris.v2y[i] = positions[i2 + 1];
            tris.v2z[i] = positions[i2 + 2];
            // face normal
            const e1x = tris.v1x[i] - tris.v0x[i];
            const e1y = tris.v1y[i] - tris.v0y[i];
            const e1z = tris.v1z[i] - tris.v0z[i];
            const e2x = tris.v2x[i] - tris.v0x[i];
            const e2y = tris.v2y[i] - tris.v0y[i];
            const e2z = tris.v2z[i] - tris.v0z[i];
            let fnx = e1y * e2z - e1z * e2y;
            let fny = e1z * e2x - e1x * e2z;
            let fnz = e1x * e2y - e1y * e2x;
            const len = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
            if (len > 1e-10) {
                const invLen = 1.0 / len;
                fnx *= invLen;
                fny *= invLen;
                fnz *= invLen;
            }
            tris.nx[i] = fnx;
            tris.ny[i] = fny;
            tris.nz[i] = fnz;
            tris.indices[i] = i;
        }
        this._tris = tris;
        this._root = buildBVH(tris, 0, numTris);
    }
    // ---- Public accessors ----
    /**
     * Read-only view of the de-indexed triangle data, used by debug overlays.
     * The underlying typed arrays are reused and must not be mutated.
     *
     * @returns the triangle SoA backing this collision.
     */
    get triangles() {
        return this._tris;
    }
    // ---- Collision interface ----
    queryRay(ox, oy, oz, dx, dy, dz, maxDist) {
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-10)
            return null;
        const invLen = 1.0 / len;
        dx *= invLen;
        dy *= invLen;
        dz *= invLen;
        const idx = 1.0 / (Math.abs(dx) > 1e-12 ? dx : dx >= 0 ? 1e-12 : -1e-12);
        const idy = 1.0 / (Math.abs(dy) > 1e-12 ? dy : dy >= 0 ? 1e-12 : -1e-12);
        const idz = 1.0 / (Math.abs(dz) > 1e-12 ? dz : dz >= 0 ? 1e-12 : -1e-12);
        const hit = this._queryRayBVH(ox, oy, oz, dx, dy, dz, idx, idy, idz, maxDist);
        if (!hit)
            return null;
        return {
            x: ox + dx * hit.t,
            y: oy + dy * hit.t,
            z: oz + dz * hit.t
        };
    }
    querySphere(cx, cy, cz, radius, out) {
        return resolveIterative(cx, cy, cz, (rx, ry, rz, push) => this._deepestSpherePenetration(rx, ry, rz, radius, push), this._constraintNormals, this._push, out);
    }
    queryCapsule(cx, cy, cz, halfHeight, radius, out) {
        return resolveIterative(cx, cy, cz, (rx, ry, rz, push) => this._deepestCapsulePenetration(rx, ry, rz, halfHeight, radius, push), this._constraintNormals, this._push, out);
    }
    isFreeAt(x, y, z) {
        // Approximation: a point is in free space iff no triangle is within
        // half a voxel of it. Matches the voxel-grid notion for data derived
        // from the same carve.
        return !this._deepestSpherePenetration(x, y, z, this.voxelResolution * 0.5, this._push);
    }
    querySurfaceNormal(x, y, z, rdx, rdy, rdz) {
        const len = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
        if (len < 1e-10) {
            this._normalResult.nx = 0;
            this._normalResult.ny = 1;
            this._normalResult.nz = 0;
            return this._normalResult;
        }
        const invLen = 1.0 / len;
        const dx = rdx * invLen;
        const dy = rdy * invLen;
        const dz = rdz * invLen;
        const idx = 1.0 / (Math.abs(dx) > 1e-12 ? dx : dx >= 0 ? 1e-12 : -1e-12);
        const idy = 1.0 / (Math.abs(dy) > 1e-12 ? dy : dy >= 0 ? 1e-12 : -1e-12);
        const idz = 1.0 / (Math.abs(dz) > 1e-12 ? dz : dz >= 0 ? 1e-12 : -1e-12);
        const hit = this._queryRayBVH(x, y, z, dx, dy, dz, idx, idy, idz, 1.0);
        const result = this._normalResult;
        if (hit) {
            const i = hit.triIdx;
            result.nx = this._tris.nx[i];
            result.ny = this._tris.ny[i];
            result.nz = this._tris.nz[i];
            // Ensure normal faces toward the ray origin (against the ray direction)
            const dot = result.nx * dx + result.ny * dy + result.nz * dz;
            if (dot > 0) {
                result.nx = -result.nx;
                result.ny = -result.ny;
                result.nz = -result.nz;
            }
        }
        else {
            result.nx = 0;
            result.ny = 1;
            result.nz = 0;
        }
        return result;
    }
    // ---- BVH ray traversal (iterative, returns both t and triangle index) ----
    _queryRayBVH(ox, oy, oz, dx, dy, dz, idx, idy, idz, maxDist) {
        const root = this._root;
        if (rayAABB(ox, oy, oz, idx, idy, idz, root.minX, root.minY, root.minZ, root.maxX, root.maxY, root.maxZ, maxDist) < 0) {
            return null;
        }
        const stack = this._stack;
        let top = 0;
        stack[top++] = root;
        let bestT = maxDist + 1;
        let bestTriIdx = -1;
        const { _tris: tris } = this;
        while (top > 0) {
            const node = stack[--top];
            if (node.left === null) {
                for (let j = node.triStart; j < node.triStart + node.triCount; j++) {
                    const i = tris.indices[j];
                    const ht = rayTriangle(ox, oy, oz, dx, dy, dz, tris.v0x[i], tris.v0y[i], tris.v0z[i], tris.v1x[i], tris.v1y[i], tris.v1z[i], tris.v2x[i], tris.v2y[i], tris.v2z[i]);
                    if (ht >= 0 && ht <= maxDist && ht < bestT) {
                        bestT = ht;
                        bestTriIdx = i;
                    }
                }
                continue;
            }
            const tLeft = rayAABB(ox, oy, oz, idx, idy, idz, node.left.minX, node.left.minY, node.left.minZ, node.left.maxX, node.left.maxY, node.left.maxZ, bestT);
            const tRight = rayAABB(ox, oy, oz, idx, idy, idz, node.right.minX, node.right.minY, node.right.minZ, node.right.maxX, node.right.maxY, node.right.maxZ, bestT);
            // Push farther child first so nearer child is popped first
            if (tLeft >= 0 && tRight >= 0) {
                if (tLeft <= tRight) {
                    stack[top++] = node.right;
                    stack[top++] = node.left;
                }
                else {
                    stack[top++] = node.left;
                    stack[top++] = node.right;
                }
            }
            else if (tLeft >= 0) {
                stack[top++] = node.left;
            }
            else if (tRight >= 0) {
                stack[top++] = node.right;
            }
        }
        if (bestTriIdx < 0)
            return null;
        const result = this._rayResult;
        result.t = bestT;
        result.triIdx = bestTriIdx;
        return result;
    }
    // ---- Sphere deepest penetration (single triangle) ----
    _deepestSpherePenetration(cx, cy, cz, radius, out) {
        let bestPen = PENETRATION_EPSILON;
        let bestPx = 0, bestPy = 0, bestPz = 0;
        let found = false;
        this._sphereBVH(this._root, cx, cy, cz, radius, (triIdx) => {
            const tris = this._tris;
            closestPointOnTriangle(cx, cy, cz, tris.v0x[triIdx], tris.v0y[triIdx], tris.v0z[triIdx], tris.v1x[triIdx], tris.v1y[triIdx], tris.v1z[triIdx], tris.v2x[triIdx], tris.v2y[triIdx], tris.v2z[triIdx], _closest);
            const dx = cx - _closest.x;
            const dy = cy - _closest.y;
            const dz = cz - _closest.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq >= radius * radius)
                return;
            const dist = Math.sqrt(distSq);
            const penetration = radius - dist;
            if (penetration > bestPen) {
                bestPen = penetration;
                if (dist > 1e-10) {
                    const invDist = 1.0 / dist;
                    bestPx = dx * invDist * penetration;
                    bestPy = dy * invDist * penetration;
                    bestPz = dz * invDist * penetration;
                }
                else {
                    bestPx = tris.nx[triIdx] * penetration;
                    bestPy = tris.ny[triIdx] * penetration;
                    bestPz = tris.nz[triIdx] * penetration;
                }
                found = true;
            }
        });
        if (found) {
            out.x = bestPx;
            out.y = bestPy;
            out.z = bestPz;
        }
        return found;
    }
    // ---- Capsule deepest penetration (single triangle) ----
    _deepestCapsulePenetration(cx, cy, cz, halfHeight, radius, out) {
        let bestPen = PENETRATION_EPSILON;
        let bestPx = 0, bestPy = 0, bestPz = 0;
        let found = false;
        const s0x = cx, s0y = cy - halfHeight, s0z = cz;
        const s1x = cx, s1y = cy + halfHeight, s1z = cz;
        const capsuleRadius = radius;
        const capsuleCenterY = cy;
        const capsuleHalfExtentY = halfHeight + radius;
        this._capsuleBVH(this._root, cx, capsuleCenterY, cz, capsuleHalfExtentY, capsuleRadius, (triIdx) => {
            const tris = this._tris;
            closestSegmentTriangle(s0x, s0y, s0z, s1x, s1y, s1z, tris.v0x[triIdx], tris.v0y[triIdx], tris.v0z[triIdx], tris.v1x[triIdx], tris.v1y[triIdx], tris.v1z[triIdx], tris.v2x[triIdx], tris.v2y[triIdx], tris.v2z[triIdx], _segClosest, _triClosest);
            const dx = _segClosest.x - _triClosest.x;
            const dy = _segClosest.y - _triClosest.y;
            const dz = _segClosest.z - _triClosest.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq >= radius * radius)
                return;
            const dist = Math.sqrt(distSq);
            const penetration = radius - dist;
            if (penetration > bestPen) {
                bestPen = penetration;
                if (dist > 1e-10) {
                    const invDist = 1.0 / dist;
                    bestPx = dx * invDist * penetration;
                    bestPy = dy * invDist * penetration;
                    bestPz = dz * invDist * penetration;
                }
                else {
                    bestPx = tris.nx[triIdx] * penetration;
                    bestPy = tris.ny[triIdx] * penetration;
                    bestPz = tris.nz[triIdx] * penetration;
                }
                found = true;
            }
        });
        if (found) {
            out.x = bestPx;
            out.y = bestPy;
            out.z = bestPz;
        }
        return found;
    }
    // ---- BVH sphere traversal (iterative) ----
    _sphereBVH(root, cx, cy, cz, radius, callback) {
        const stack = this._stack;
        let top = 0;
        stack[top++] = root;
        while (top > 0) {
            const node = stack[--top];
            if (!sphereAABBOverlap(cx, cy, cz, radius, node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ)) {
                continue;
            }
            if (node.left === null) {
                const { _tris: tris } = this;
                for (let j = node.triStart; j < node.triStart + node.triCount; j++) {
                    callback(tris.indices[j]);
                }
                continue;
            }
            stack[top++] = node.right;
            stack[top++] = node.left;
        }
    }
    // ---- BVH capsule traversal (iterative, uses AABB of the capsule) ----
    _capsuleBVH(root, cx, cy, cz, halfExtentY, radius, callback) {
        const capMinX = cx - radius;
        const capMaxX = cx + radius;
        const capMinY = cy - halfExtentY;
        const capMaxY = cy + halfExtentY;
        const capMinZ = cz - radius;
        const capMaxZ = cz + radius;
        const stack = this._stack;
        let top = 0;
        stack[top++] = root;
        while (top > 0) {
            const node = stack[--top];
            if (capMaxX < node.minX ||
                capMinX > node.maxX ||
                capMaxY < node.minY ||
                capMinY > node.maxY ||
                capMaxZ < node.minZ ||
                capMinZ > node.maxZ) {
                continue;
            }
            if (node.left === null) {
                const { _tris: tris } = this;
                for (let j = node.triStart; j < node.triStart + node.triCount; j++) {
                    callback(tris.indices[j]);
                }
                continue;
            }
            stack[top++] = node.right;
            stack[top++] = node.left;
        }
    }
    // ---- Static factory ----
    /**
     * Load a GLB file via the PlayCanvas asset system, extract mesh geometry,
     * and construct a MeshCollision. The GLB entity is not added to the scene;
     * only the vertex/index data is used.
     *
     * @param app - PlayCanvas application instance.
     * @param url - URL to the .glb file.
     * @returns A promise resolving to a MeshCollision.
     */
    static fromGlb(app, url) {
        return new Promise((resolve, reject) => {
            const asset = new Asset(url, 'container', { url });
            const cleanup = () => {
                app.assets.remove(asset);
                asset.unload();
            };
            asset.on('load', () => {
                const renders = asset.resource.renders;
                if (!renders || renders.length === 0) {
                    cleanup();
                    reject(new Error('GLB contains no mesh data'));
                    return;
                }
                const allPositions = [];
                const allIndices = [];
                let vertexOffset = 0;
                for (const renderAsset of renders) {
                    const render = renderAsset.resource;
                    for (let m = 0; m < render.meshes.length; m++) {
                        const mesh = render.meshes[m];
                        const vb = mesh.vertexBuffer;
                        const ib = mesh.indexBuffer[0];
                        if (!vb || !ib)
                            continue;
                        const format = vb.format;
                        let posElement = null;
                        for (let e = 0; e < format.elements.length; e++) {
                            if (format.elements[e].name === SEMANTIC_POSITION) {
                                posElement = format.elements[e];
                                break;
                            }
                        }
                        if (!posElement)
                            continue;
                        const data = new Float32Array(vb.storage);
                        const stride = format.size / 4;
                        const offset = posElement.offset / 4;
                        const numVerts = vb.numVertices;
                        for (let v = 0; v < numVerts; v++) {
                            const base = v * stride + offset;
                            allPositions.push(data[base], data[base + 1], data[base + 2]);
                        }
                        const indexData = ib.format === INDEXFORMAT_UINT32
                            ? new Uint32Array(ib.storage)
                            : new Uint16Array(ib.storage);
                        for (const prim of mesh.primitive) {
                            for (let i = 0; i < prim.count; i++) {
                                allIndices.push(indexData[prim.base + i] + vertexOffset);
                            }
                        }
                        vertexOffset += numVerts;
                    }
                }
                if (allIndices.length === 0) {
                    cleanup();
                    reject(new Error('GLB meshes contain no triangle data'));
                    return;
                }
                const collision = new MeshCollision(new Float32Array(allPositions), new Uint32Array(allIndices));
                cleanup();
                resolve(collision);
            });
            asset.on('error', (err) => {
                cleanup();
                reject(new Error(err));
            });
            app.assets.add(asset);
            app.assets.load(asset);
        });
    }
}

/**
 * Solid leaf node marker: childMask = 0xFF, baseOffset = 0.
 * Unambiguous because BFS layout guarantees children always come after their parent,
 * so baseOffset = 0 is never valid for an interior node.
 */
const SOLID_LEAF_MARKER = 0xff000000 >>> 0;
/** Half-extent of the flatness sampling patch (5x5 when R=2). */
const FLAT_R = 2;
/** 1/sqrt(2), used to normalise 45-degree diagonal normals. */
const INV_SQRT2$1 = 1 / Math.sqrt(2);
/**
 * Surface normal candidate directions for querySurfaceNormal.
 * Each entry: [dx, dy, dz, t1x, t1y, t1z, t2x, t2y, t2z]
 *   (dx,dy,dz) = canonical normal direction (components 0 or +/-1)
 *   (t1,t2) = orthogonal tangent vectors spanning the perpendicular sampling plane
 */
const SURFACE_CANDIDATES = [
    // Axis-aligned
    [1, 0, 0, 0, 1, 0, 0, 0, 1],
    [0, 1, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0, 0, 0, 1, 0],
    // XZ diagonals (vertical walls at 45 degrees)
    [1, 0, 1, 0, 1, 0, -1, 0, 1],
    [1, 0, -1, 0, 1, 0, 1, 0, 1],
    // XY diagonals (walls tilted from vertical)
    [1, 1, 0, 0, 0, 1, -1, 1, 0],
    [1, -1, 0, 0, 0, 1, 1, 1, 0],
    // YZ diagonals (sloped floors/ceilings)
    [0, 1, 1, 1, 0, 0, 0, -1, 1],
    [0, 1, -1, 1, 0, 0, 0, 1, 1]
];
/**
 * Score a surface candidate direction by sampling a 5x5 patch at three depth layers
 * shifted along the step direction. Returns the best (maximum) layer score. A "surface
 * hit" at each sample is a solid voxel whose neighbour in the step direction is empty.
 *
 * @param collision - The voxel collision instance.
 * @param ix - Voxel X index of the surface point.
 * @param iy - Voxel Y index of the surface point.
 * @param iz - Voxel Z index of the surface point.
 * @param sx - Step X component (camera-facing direction).
 * @param sy - Step Y component.
 * @param sz - Step Z component.
 * @param t1x - First tangent vector X.
 * @param t1y - First tangent vector Y.
 * @param t1z - First tangent vector Z.
 * @param t2x - Second tangent vector X.
 * @param t2y - Second tangent vector Y.
 * @param t2z - Second tangent vector Z.
 * @returns The best score across the three depth layers.
 */
function scoreSurfaceCandidate(collision, ix, iy, iz, sx, sy, sz, t1x, t1y, t1z, t2x, t2y, t2z) {
    let best = 0;
    for (let depth = 1; depth >= -1; depth--) {
        let s = 0;
        for (let da = -FLAT_R; da <= FLAT_R; da++) {
            for (let db = -FLAT_R; db <= FLAT_R; db++) {
                const px = ix + da * t1x + db * t2x - sx * depth;
                const py = iy + da * t1y + db * t2y - sy * depth;
                const pz = iz + da * t1z + db * t2z - sz * depth;
                if (collision.isVoxelSolid(px, py, pz) && !collision.isVoxelSolid(px + sx, py + sy, pz + sz)) {
                    s++;
                }
            }
        }
        if (s > best)
            best = s;
    }
    return best;
}
/**
 * Count the number of set bits in a 32-bit integer.
 *
 * @param n - 32-bit integer.
 * @returns Number of bits set to 1.
 */
function popcount(n) {
    n >>>= 0;
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
/**
 * Runtime sparse voxel octree collider.
 *
 * Loads the two-file format (.voxel.json + .voxel.bin) produced by
 * splat-transform's writeVoxel and provides point and sphere collision queries.
 */
class VoxelCollision {
    /** Grid-aligned bounds (min xyz) */
    _gridMinX;
    _gridMinY;
    _gridMinZ;
    /** Number of voxels along each axis */
    _numVoxelsX;
    _numVoxelsY;
    _numVoxelsZ;
    /** Size of each voxel in world units */
    _voxelResolution;
    /** Voxels per leaf dimension (always 4) */
    _leafSize;
    /** Maximum tree depth (number of octree levels above the leaf level) */
    _treeDepth;
    /** Flat Laine-Karras node array */
    _nodes;
    /** Leaf voxel masks: pairs of (lo, hi) Uint32 per mixed leaf */
    _leafData;
    /** Pre-allocated scratch push-out vector to avoid per-frame allocations */
    _push = { x: 0, y: 0, z: 0 };
    /** Pre-allocated result for querySurfaceNormal to avoid per-call allocation */
    _normalResult = { nx: 0, ny: 0, nz: 0 };
    /** Pre-allocated constraint normals for iterative corner resolution (max 3 walls) */
    _constraintNormals = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];
    constructor(metadata, nodes, leafData) {
        this._gridMinX = metadata.gridBounds.min[0];
        this._gridMinY = metadata.gridBounds.min[1];
        this._gridMinZ = metadata.gridBounds.min[2];
        const res = metadata.voxelResolution;
        this._numVoxelsX = Math.round((metadata.gridBounds.max[0] - metadata.gridBounds.min[0]) / res);
        this._numVoxelsY = Math.round((metadata.gridBounds.max[1] - metadata.gridBounds.min[1]) / res);
        this._numVoxelsZ = Math.round((metadata.gridBounds.max[2] - metadata.gridBounds.min[2]) / res);
        this._voxelResolution = res;
        this._leafSize = metadata.leafSize;
        this._treeDepth = metadata.treeDepth;
        this._nodes = nodes;
        this._leafData = leafData;
    }
    /**
     * Grid-aligned bounds minimum X in world units.
     *
     * @returns {number} The minimum X coordinate.
     */
    get gridMinX() {
        return this._gridMinX;
    }
    /**
     * Grid-aligned bounds minimum Y in world units.
     *
     * @returns {number} The minimum Y coordinate.
     */
    get gridMinY() {
        return this._gridMinY;
    }
    /**
     * Grid-aligned bounds minimum Z in world units.
     *
     * @returns {number} The minimum Z coordinate.
     */
    get gridMinZ() {
        return this._gridMinZ;
    }
    /**
     * Number of voxels along the X axis.
     *
     * @returns {number} The voxel count on X.
     */
    get numVoxelsX() {
        return this._numVoxelsX;
    }
    /**
     * Number of voxels along the Y axis.
     *
     * @returns {number} The voxel count on Y.
     */
    get numVoxelsY() {
        return this._numVoxelsY;
    }
    /**
     * Number of voxels along the Z axis.
     *
     * @returns {number} The voxel count on Z.
     */
    get numVoxelsZ() {
        return this._numVoxelsZ;
    }
    /**
     * Size of each voxel in world units.
     *
     * @returns {number} The voxel resolution.
     */
    get voxelResolution() {
        return this._voxelResolution;
    }
    /**
     * Voxels per leaf dimension (always 4).
     *
     * @returns {number} The leaf size.
     */
    get leafSize() {
        return this._leafSize;
    }
    /**
     * Maximum tree depth (number of octree levels above the leaf level).
     *
     * @returns {number} The tree depth.
     */
    get treeDepth() {
        return this._treeDepth;
    }
    /**
     * Flat Laine-Karras node array (read-only access for GPU upload).
     *
     * @returns {Uint32Array} The node array.
     */
    get nodes() {
        return this._nodes;
    }
    /**
     * Leaf voxel masks: pairs of (lo, hi) Uint32 per mixed leaf (read-only access for GPU upload).
     *
     * @returns {Uint32Array} The leaf data array.
     */
    get leafData() {
        return this._leafData;
    }
    /**
     * Whether this data requires X/Y negation (legacy v1.0 format).
     *
     * @returns {boolean} True if coordinates need flipping.
     */
    // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- preserve prototype getter semantics
    get flipXY() {
        return false;
    }
    isFreeAt(x, y, z) {
        // Without voxel data, there's no carve to consult — report not-free
        // rather than have the lattice search treat the world as wide open.
        if (this._nodes.length === 0) {
            return false;
        }
        const res = this._voxelResolution;
        const ix = Math.floor((x - this._gridMinX) / res);
        const iy = Math.floor((y - this._gridMinY) / res);
        const iz = Math.floor((z - this._gridMinZ) / res);
        // Outside the carved grid is "no data" — also not-free. Without this
        // check the lattice search would spend candidates on out-of-bounds
        // cells (and `isVoxelSolid` would mislead callers by returning false).
        if (ix < 0 || iy < 0 || iz < 0 || ix >= this._numVoxelsX || iy >= this._numVoxelsY || iz >= this._numVoxelsZ) {
            return false;
        }
        return !this.isVoxelSolid(ix, iy, iz);
    }
    querySurfaceNormal(x, y, z, rdx, rdy, rdz) {
        const nudge = this._voxelResolution * 0.25;
        const ix = Math.floor((x + Math.sign(rdx) * nudge - this._gridMinX) / this._voxelResolution);
        const iy = Math.floor((y + Math.sign(rdy) * nudge - this._gridMinY) / this._voxelResolution);
        const iz = Math.floor((z + Math.sign(rdz) * nudge - this._gridMinZ) / this._voxelResolution);
        const result = this._normalResult;
        let bestScore = -1;
        let bestNx = 0;
        let bestNy = 1;
        let bestNz = 0;
        for (let c = 0; c < SURFACE_CANDIDATES.length; c++) {
            const cand = SURFACE_CANDIDATES[c];
            const dx = cand[0];
            const dy = cand[1];
            const dz = cand[2];
            const dot = rdx * dx + rdy * dy + rdz * dz;
            if (Math.abs(dot) < 1e-6)
                continue;
            const sign = dot < 0 ? 1 : -1;
            const sx = dx * sign;
            const sy = dy * sign;
            const sz = dz * sign;
            const score = scoreSurfaceCandidate(this, ix, iy, iz, sx, sy, sz, cand[3], cand[4], cand[5], cand[6], cand[7], cand[8]);
            if (score > bestScore) {
                bestScore = score;
                const mag = Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1 ? INV_SQRT2$1 : 1;
                bestNx = sx * mag;
                bestNy = sy * mag;
                bestNz = sz * mag;
            }
        }
        result.nx = bestNx;
        result.ny = bestNy;
        result.nz = bestNz;
        return result;
    }
    queryRay(ox, oy, oz, dx, dy, dz, maxDist) {
        if (this._nodes.length === 0) {
            return null;
        }
        const res = this._voxelResolution;
        const gMinX = this._gridMinX;
        const gMinY = this._gridMinY;
        const gMinZ = this._gridMinZ;
        const gMaxX = gMinX + this._numVoxelsX * res;
        const gMaxY = gMinY + this._numVoxelsY * res;
        const gMaxZ = gMinZ + this._numVoxelsZ * res;
        const EPS = 1e-12;
        // Ray-AABB slab intersection to find the range [tNear, tFar]
        let tNear = 0;
        let tFar = maxDist;
        if (Math.abs(dx) > EPS) {
            let t1 = (gMinX - ox) / dx;
            let t2 = (gMaxX - ox) / dx;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
            }
            tFar = Math.min(tFar, t2);
            if (tNear > tFar)
                return null;
        }
        else if (ox < gMinX || ox >= gMaxX) {
            return null;
        }
        if (Math.abs(dy) > EPS) {
            let t1 = (gMinY - oy) / dy;
            let t2 = (gMaxY - oy) / dy;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
            }
            tFar = Math.min(tFar, t2);
            if (tNear > tFar)
                return null;
        }
        else if (oy < gMinY || oy >= gMaxY) {
            return null;
        }
        if (Math.abs(dz) > EPS) {
            let t1 = (gMinZ - oz) / dz;
            let t2 = (gMaxZ - oz) / dz;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
            }
            tFar = Math.min(tFar, t2);
            if (tNear > tFar)
                return null;
        }
        else if (oz < gMinZ || oz >= gMaxZ) {
            return null;
        }
        // Entry point on the grid AABB (or origin if already inside)
        const entryX = ox + dx * tNear;
        const entryY = oy + dy * tNear;
        const entryZ = oz + dz * tNear;
        // Convert to voxel indices, clamping to valid range for boundary cases
        let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / res), this._numVoxelsX - 1));
        let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / res), this._numVoxelsY - 1));
        let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / res), this._numVoxelsZ - 1));
        // DDA setup
        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
        const invDx = Math.abs(dx) > EPS ? 1.0 / dx : 0;
        const invDy = Math.abs(dy) > EPS ? 1.0 / dy : 0;
        const invDz = Math.abs(dz) > EPS ? 1.0 / dz : 0;
        let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * res - ox) * invDx : Infinity;
        let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * res - oy) * invDy : Infinity;
        let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * res - oz) * invDz : Infinity;
        const tDeltaX = Math.abs(dx) > EPS ? res * Math.abs(invDx) : Infinity;
        const tDeltaY = Math.abs(dy) > EPS ? res * Math.abs(invDy) : Infinity;
        const tDeltaZ = Math.abs(dz) > EPS ? res * Math.abs(invDz) : Infinity;
        let currentT = tNear;
        const maxSteps = this._numVoxelsX + this._numVoxelsY + this._numVoxelsZ;
        for (let step = 0; step < maxSteps; step++) {
            if (this.isVoxelSolid(ix, iy, iz)) {
                return {
                    x: ox + dx * currentT,
                    y: oy + dy * currentT,
                    z: oz + dz * currentT
                };
            }
            // Advance along the axis with the smallest tMax
            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) {
                    currentT = tMaxX;
                    ix += stepX;
                    tMaxX += tDeltaX;
                }
                else {
                    currentT = tMaxZ;
                    iz += stepZ;
                    tMaxZ += tDeltaZ;
                }
            }
            else if (tMaxY < tMaxZ) {
                currentT = tMaxY;
                iy += stepY;
                tMaxY += tDeltaY;
            }
            else {
                currentT = tMaxZ;
                iz += stepZ;
                tMaxZ += tDeltaZ;
            }
            if (ix < 0 ||
                iy < 0 ||
                iz < 0 ||
                ix >= this._numVoxelsX ||
                iy >= this._numVoxelsY ||
                iz >= this._numVoxelsZ ||
                currentT > maxDist) {
                return null;
            }
        }
        return null;
    }
    querySphere(cx, cy, cz, radius, out) {
        if (this.nodes.length === 0) {
            return false;
        }
        return resolveIterative(cx, cy, cz, (rx, ry, rz, push) => this.resolveDeepestPenetration(rx, ry, rz, radius, push), this._constraintNormals, this._push, out);
    }
    queryCapsule(cx, cy, cz, halfHeight, radius, out) {
        if (this.nodes.length === 0) {
            return false;
        }
        return resolveIterative(cx, cy, cz, (rx, ry, rz, push) => this.resolveDeepestPenetrationCapsule(rx, ry, rz, halfHeight, radius, push), this._constraintNormals, this._push, out);
    }
    /**
     * Find the single deepest penetrating voxel for the given sphere.
     *
     * @param cx - Sphere center X.
     * @param cy - Sphere center Y.
     * @param cz - Sphere center Z.
     * @param radius - Sphere radius.
     * @param out - Receives the push-out vector on success.
     * @returns True if a penetrating voxel was found.
     */
    resolveDeepestPenetration(cx, cy, cz, radius, out) {
        const { voxelResolution, gridMinX, gridMinY, gridMinZ } = this;
        const radiusSq = radius * radius;
        // Compute bounding box of the sphere in voxel indices
        const ixMin = Math.floor((cx - radius - gridMinX) / voxelResolution);
        const iyMin = Math.floor((cy - radius - gridMinY) / voxelResolution);
        const izMin = Math.floor((cz - radius - gridMinZ) / voxelResolution);
        const ixMax = Math.floor((cx + radius - gridMinX) / voxelResolution);
        const iyMax = Math.floor((cy + radius - gridMinY) / voxelResolution);
        const izMax = Math.floor((cz + radius - gridMinZ) / voxelResolution);
        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPenetration = PENETRATION_EPSILON;
        let found = false;
        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }
                    // Compute the world-space AABB of this voxel
                    const vMinX = gridMinX + ix * voxelResolution;
                    const vMinY = gridMinY + iy * voxelResolution;
                    const vMinZ = gridMinZ + iz * voxelResolution;
                    const vMaxX = vMinX + voxelResolution;
                    const vMaxY = vMinY + voxelResolution;
                    const vMaxZ = vMinZ + voxelResolution;
                    // Find the nearest point on the voxel AABB to the sphere center
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(cy, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    // Vector from nearest point to sphere center
                    const dx = cx - nearX;
                    const dy = cy - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq >= radiusSq) {
                        continue;
                    }
                    let px;
                    let py;
                    let pz;
                    let penetration;
                    if (distSq > 1e-12) {
                        // Center is outside the voxel: push radially outward
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1.0 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    }
                    else {
                        // Center is inside the voxel: push to nearest face + radius
                        // so the sphere surface ends up flush with the face
                        const distNegX = cx - vMinX;
                        const distPosX = vMaxX - cx;
                        const distNegY = cy - vMinY;
                        const distPosY = vMaxY - cy;
                        const distNegZ = cz - vMinZ;
                        const distPosZ = vMaxZ - cz;
                        const escapeX = distNegX < distPosX ? -(distNegX + radius) : distPosX + radius;
                        const escapeY = distNegY < distPosY ? -(distNegY + radius) : distPosY + radius;
                        const escapeZ = distNegZ < distPosZ ? -(distNegZ + radius) : distPosZ + radius;
                        const absX = Math.abs(escapeX);
                        const absY = Math.abs(escapeY);
                        const absZ = Math.abs(escapeZ);
                        px = 0;
                        py = 0;
                        pz = 0;
                        if (absX <= absY && absX <= absZ) {
                            px = escapeX;
                            penetration = absX;
                        }
                        else if (absY <= absZ) {
                            py = escapeY;
                            penetration = absY;
                        }
                        else {
                            pz = escapeZ;
                            penetration = absZ;
                        }
                    }
                    if (penetration > bestPenetration) {
                        bestPenetration = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            out.x = bestPushX;
            out.y = bestPushY;
            out.z = bestPushZ;
        }
        return found;
    }
    /**
     * Find the single deepest penetrating voxel for the given vertical capsule.
     * The capsule is a line segment from (cx, cy - halfHeight, cz) to (cx, cy + halfHeight, cz)
     * swept by radius. For each voxel, the closest point on the segment to the AABB is found,
     * then a sphere-AABB penetration test is performed from that point.
     *
     * @param cx - Capsule center X.
     * @param cy - Capsule center Y.
     * @param cz - Capsule center Z.
     * @param halfHeight - Half-height of the capsule's inner line segment.
     * @param radius - Capsule radius.
     * @param out - Receives the push-out vector on success.
     * @returns True if a penetrating voxel was found.
     */
    resolveDeepestPenetrationCapsule(cx, cy, cz, halfHeight, radius, out) {
        const { voxelResolution, gridMinX, gridMinY, gridMinZ } = this;
        const radiusSq = radius * radius;
        const segBottomY = cy - halfHeight;
        const segTopY = cy + halfHeight;
        // Compute bounding box of the capsule in voxel indices
        const ixMin = Math.floor((cx - radius - gridMinX) / voxelResolution);
        const iyMin = Math.floor((segBottomY - radius - gridMinY) / voxelResolution);
        const izMin = Math.floor((cz - radius - gridMinZ) / voxelResolution);
        const ixMax = Math.floor((cx + radius - gridMinX) / voxelResolution);
        const iyMax = Math.floor((segTopY + radius - gridMinY) / voxelResolution);
        const izMax = Math.floor((cz + radius - gridMinZ) / voxelResolution);
        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPenetration = PENETRATION_EPSILON;
        let found = false;
        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }
                    // Compute the world-space AABB of this voxel
                    const vMinX = gridMinX + ix * voxelResolution;
                    const vMinY = gridMinY + iy * voxelResolution;
                    const vMinZ = gridMinZ + iz * voxelResolution;
                    const vMaxX = vMinX + voxelResolution;
                    const vMaxY = vMinY + voxelResolution;
                    const vMaxZ = vMinZ + voxelResolution;
                    // Find the closest Y on the capsule segment to this AABB.
                    // For a vertical segment, X and Z are fixed so we only optimize Y.
                    let segY;
                    if (segTopY < vMinY) {
                        // segment entirely below AABB
                        segY = segTopY;
                    }
                    else if (segBottomY > vMaxY) {
                        // segment entirely above AABB
                        segY = segBottomY;
                    }
                    else {
                        // ranges overlap - pick segment Y closest to AABB center
                        const aabbCenterY = (vMinY + vMaxY) * 0.5;
                        segY = Math.max(segBottomY, Math.min(segTopY, aabbCenterY));
                    }
                    // Now do sphere-AABB penetration from (cx, segY, cz)
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    // Vector from nearest point to sphere center on segment
                    const dx = cx - nearX;
                    const dy = segY - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq >= radiusSq) {
                        continue;
                    }
                    let px;
                    let py;
                    let pz;
                    let penetration;
                    if (distSq > 1e-12) {
                        // Sphere center is outside the voxel: push radially outward
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1.0 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    }
                    else {
                        // Segment point is inside the voxel: push to nearest face + radius
                        // so the capsule surface ends up flush with the face
                        const distNegX = cx - vMinX;
                        const distPosX = vMaxX - cx;
                        const distNegY = segY - vMinY;
                        const distPosY = vMaxY - segY;
                        const distNegZ = cz - vMinZ;
                        const distPosZ = vMaxZ - cz;
                        const escapeX = distNegX < distPosX ? -(distNegX + radius) : distPosX + radius;
                        const escapeY = distNegY < distPosY ? -(distNegY + radius) : distPosY + radius;
                        const escapeZ = distNegZ < distPosZ ? -(distNegZ + radius) : distPosZ + radius;
                        const absX = Math.abs(escapeX);
                        const absY = Math.abs(escapeY);
                        const absZ = Math.abs(escapeZ);
                        px = 0;
                        py = 0;
                        pz = 0;
                        if (absX <= absY && absX <= absZ) {
                            px = escapeX;
                            penetration = absX;
                        }
                        else if (absY <= absZ) {
                            py = escapeY;
                            penetration = absY;
                        }
                        else {
                            pz = escapeZ;
                            penetration = absZ;
                        }
                    }
                    if (penetration > bestPenetration) {
                        bestPenetration = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            out.x = bestPushX;
            out.y = bestPushY;
            out.z = bestPushZ;
        }
        return found;
    }
    /**
     * Test whether a voxel at the given grid indices is solid.
     *
     * @param ix - Global voxel X index.
     * @param iy - Global voxel Y index.
     * @param iz - Global voxel Z index.
     * @returns True if the voxel is solid.
     */
    isVoxelSolid(ix, iy, iz) {
        if (this.nodes.length === 0 ||
            ix < 0 ||
            iy < 0 ||
            iz < 0 ||
            ix >= this.numVoxelsX ||
            iy >= this.numVoxelsY ||
            iz >= this.numVoxelsZ) {
            return false;
        }
        const { leafSize, treeDepth } = this;
        // Convert voxel indices to block coordinates
        const blockX = Math.floor(ix / leafSize);
        const blockY = Math.floor(iy / leafSize);
        const blockZ = Math.floor(iz / leafSize);
        // Traverse octree from root to leaf
        let nodeIndex = 0;
        for (let level = treeDepth - 1; level >= 0; level--) {
            const node = this.nodes[nodeIndex] >>> 0;
            // Check for solid leaf sentinel first (has nonzero high byte)
            if (node === SOLID_LEAF_MARKER) {
                return true;
            }
            const childMask = (node >>> 24) & 0xff;
            // If childMask is 0, this is a mixed leaf node
            if (childMask === 0) {
                return this.checkLeafByIndex(node, ix, iy, iz);
            }
            // Determine which octant the block falls into at this level
            const bitX = (blockX >>> level) & 1;
            const bitY = (blockY >>> level) & 1;
            const bitZ = (blockZ >>> level) & 1;
            const octant = (bitZ << 2) | (bitY << 1) | bitX;
            // Check if this octant has a child
            if ((childMask & (1 << octant)) === 0) {
                return false;
            }
            // Calculate child offset using popcount of lower bits
            const baseOffset = node & 0x00ffffff;
            const prefix = (1 << octant) - 1;
            const childOffset = popcount(childMask & prefix);
            nodeIndex = baseOffset + childOffset;
        }
        // We've reached the leaf level
        const node = this.nodes[nodeIndex] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }
        return this.checkLeafByIndex(node, ix, iy, iz);
    }
    /**
     * Check a mixed leaf node using voxel grid indices.
     * The solid leaf sentinel must be checked before calling this method.
     *
     * @param node - The mixed leaf node value (lower 24 bits = leafData index).
     * @param ix - Global voxel X index.
     * @param iy - Global voxel Y index.
     * @param iz - Global voxel Z index.
     * @returns True if the voxel is solid.
     */
    checkLeafByIndex(node, ix, iy, iz) {
        const leafDataIndex = node & 0x00ffffff;
        // Compute voxel coordinates within the 4x4x4 block
        const vx = ix & 3;
        const vy = iy & 3;
        const vz = iz & 3;
        // Bit index within the 64-bit mask: z * 16 + y * 4 + x
        const bitIndex = vz * 16 + vy * 4 + vx;
        // Read the appropriate 32-bit word (lo or hi)
        if (bitIndex < 32) {
            const lo = this.leafData[leafDataIndex * 2] >>> 0;
            return ((lo >>> bitIndex) & 1) === 1;
        }
        const hi = this.leafData[leafDataIndex * 2 + 1] >>> 0;
        return ((hi >>> (bitIndex - 32)) & 1) === 1;
    }
}
/**
 * Legacy v1.0 adapter that negates X/Y on inputs and outputs to convert
 * between PlayCanvas world space and the raw voxel data coordinate system.
 */
class FlippedVoxelCollision extends VoxelCollision {
    // eslint-disable-next-line @typescript-eslint/class-literal-property-style -- preserve prototype getter semantics
    get flipXY() {
        return true;
    }
    querySurfaceNormal(x, y, z, rdx, rdy, rdz) {
        const result = super.querySurfaceNormal(-x, -y, z, -rdx, -rdy, rdz);
        result.nx = -result.nx;
        result.ny = -result.ny;
        return result;
    }
    queryRay(ox, oy, oz, dx, dy, dz, maxDist) {
        const hit = super.queryRay(-ox, -oy, oz, -dx, -dy, dz, maxDist);
        if (hit) {
            hit.x = -hit.x;
            hit.y = -hit.y;
        }
        return hit;
    }
    querySphere(cx, cy, cz, radius, out) {
        const result = super.querySphere(-cx, -cy, cz, radius, out);
        if (result) {
            out.x = -out.x;
            out.y = -out.y;
        }
        return result;
    }
    queryCapsule(cx, cy, cz, halfHeight, radius, out) {
        const result = super.queryCapsule(-cx, -cy, cz, halfHeight, radius, out);
        if (result) {
            out.x = -out.x;
            out.y = -out.y;
        }
        return result;
    }
    isFreeAt(x, y, z) {
        return super.isFreeAt(-x, -y, z);
    }
}
/**
 * Load a VoxelCollision from a .voxel.json URL.
 * The corresponding .voxel.bin is inferred by replacing the extension.
 * Returns a FlippedVoxelCollision for legacy v1.0 data.
 *
 * @param jsonUrl - URL to the .voxel.json metadata file.
 * @returns A promise resolving to a VoxelCollision instance.
 */
const loadVoxelCollision = async (jsonUrl) => {
    const metaResponse = await fetch(jsonUrl);
    if (!metaResponse.ok) {
        throw new Error(`Failed to fetch voxel metadata: ${metaResponse.statusText}`);
    }
    const metadata = await metaResponse.json();
    const binUrl = jsonUrl.replace('.voxel.json', '.voxel.bin');
    const binResponse = await fetch(binUrl);
    if (!binResponse.ok) {
        throw new Error(`Failed to fetch voxel binary: ${binResponse.statusText}`);
    }
    const buffer = await binResponse.arrayBuffer();
    const view = new Uint32Array(buffer);
    const nodes = view.slice(0, metadata.nodeCount);
    const leafData = view.slice(metadata.nodeCount, metadata.nodeCount + metadata.leafDataCount);
    const isLegacy = !metadata.version || parseFloat(metadata.version) < 1.1;
    if (isLegacy) {
        return new FlippedVoxelCollision(metadata, nodes, leafData);
    }
    return new VoxelCollision(metadata, nodes, leafData);
};

// creates an observer proxy object to wrap some target object. fires events when properties change.
const observe = (events, target) => {
    const members = new Set(Object.keys(target));
    return new Proxy(target, {
        set(target, property, value, _receiver) {
            // prevent setting symbol properties
            if (typeof property === 'symbol') {
                console.error('Cannot set symbol property on target');
                return false;
            }
            // not allowed to set a new value on target
            if (!members.has(property)) {
                console.error('Cannot set new property on target');
                return false;
            }
            // set and fire event if value changed
            if (target[property] !== value) {
                const prev = target[property];
                target[property] = value;
                events.fire(`${property}:changed`, value, prev);
            }
            return true;
        }
    });
};

var deJson = {
	"settings.performance-mode": "Leistungsmodus",
	"settings.gaming-controls": "Gaming-Steuerung",
	"settings.show-annotations": "Anmerkungen anzeigen",
	"settings.show-collision": "Kollision anzeigen",
	"settings.frame": "Einpassen",
	"settings.reset": "Zurücksetzen",
	"tooltip.play": "Wiedergabe",
	"tooltip.pause": "Pause",
	"tooltip.orbit-camera": "Umlaufkamera",
	"tooltip.fly-camera": "Flugkamera",
	"tooltip.walk-mode": "Gehmodus",
	"tooltip.reset-camera": "Kamera zurücksetzen",
	"tooltip.frame-scene": "Szene einpassen",
	"tooltip.settings": "Einstellungen",
	"tooltip.help": "Info",
	"tooltip.controls": "Steuerung",
	"tooltip.enter-ar": "AR starten",
	"tooltip.enter-vr": "VR starten",
	"tooltip.fullscreen": "Vollbild",
	"help.section.orbit": "Umlaufmodus",
	"help.section.fly": "Flugmodus",
	"help.section.walk": "Gehmodus",
	"help.section.anim": "Animation",
	"help.section.modes": "Modus wechseln",
	"help.action.orbit": "Umkreisen",
	"help.action.pan": "Schwenken",
	"help.action.zoom": "Zoomen",
	"help.action.set-focus": "Fokus setzen",
	"help.action.fly-to": "Fliegen zu",
	"help.action.fly-to-point": "Zum Punkt fliegen",
	"help.action.walk-to": "Gehen zu",
	"help.action.look-around": "Umsehen",
	"help.action.move": "Bewegen",
	"help.action.vertical": "Vertikal",
	"help.action.jump": "Springen",
	"help.action.run-slow": "Rennen / Gehen",
	"help.action.focus-point": "Fokuspunkt",
	"help.action.frame-scene": "Szene einpassen",
	"help.action.reset-camera": "Kamera zurücksetzen",
	"help.action.orbit-mode": "Umlaufmodus",
	"help.action.fly-mode": "Flugmodus",
	"help.action.toggle-walk": "Gehen umschalten",
	"help.action.toggle-gaming": "Gaming-Steuerung umschalten",
	"help.action.show-collision": "Kollision anzeigen",
	"help.action.play-pause": "Wiedergabe / Pause",
	"help.action.toggle-controls": "Steuerung umschalten",
	"help.action.toggle-help": "Info umschalten",
	"help.action.exit-cancel": "Beenden / Abbrechen",
	"help.action.release-mouse": "Maus freigeben",
	"help.action.exit-walk": "Gehmodus beenden",
	"help.key.double-tap": "Doppeltippen",
	"help.key.tap": "Tippen",
	"help.key.touch-drag": "Berühren + Ziehen",
	"help.key.one-finger-drag": "Mit einem Finger ziehen",
	"help.key.two-finger-drag": "Mit zwei Fingern ziehen",
	"help.key.pinch": "Zwei-Finger-Zoom",
	"help.key.pinch-two-finger": "Zwei-Finger-Zoom / Ziehen",
	"help.key.joystick": "Joystick",
	"help.key.space": "Leertaste",
	"help.key.esc": "Esc",
	"xr-modal.title": "WebGL erforderlich",
	"xr-modal.message": "AR und VR werden vom WebGPU-Renderer nicht unterstützt. Mit OK wird der Viewer mit WebGL neu geladen.",
	"xr-modal.cancel": "Abbrechen",
	"xr-modal.ok": "OK"
};

var enJson = {
	"settings.performance-mode": "Performance Mode",
	"settings.gaming-controls": "Gaming Controls",
	"settings.show-annotations": "Show Annotations",
	"settings.show-collision": "Show Collision",
	"settings.frame": "Frame",
	"settings.reset": "Reset",
	"tooltip.play": "Play",
	"tooltip.pause": "Pause",
	"tooltip.orbit-camera": "Orbit Camera",
	"tooltip.fly-camera": "Fly Camera",
	"tooltip.walk-mode": "Walk Mode",
	"tooltip.reset-camera": "Reset Camera",
	"tooltip.frame-scene": "Frame Scene",
	"tooltip.settings": "Settings",
	"tooltip.help": "Info",
	"tooltip.controls": "Controls",
	"tooltip.enter-ar": "Enter AR",
	"tooltip.enter-vr": "Enter VR",
	"tooltip.fullscreen": "Fullscreen",
	"help.section.orbit": "Orbit Mode",
	"help.section.fly": "Fly Mode",
	"help.section.walk": "Walk Mode",
	"help.section.anim": "Animation",
	"help.section.modes": "Mode Switching",
	"help.action.orbit": "Orbit",
	"help.action.pan": "Pan",
	"help.action.zoom": "Zoom",
	"help.action.set-focus": "Set Focus",
	"help.action.fly-to": "Fly To",
	"help.action.fly-to-point": "Fly to Point",
	"help.action.walk-to": "Walk To",
	"help.action.look-around": "Look Around",
	"help.action.move": "Move",
	"help.action.vertical": "Vertical",
	"help.action.jump": "Jump",
	"help.action.run-slow": "Run / Slow",
	"help.action.focus-point": "Focus Point",
	"help.action.frame-scene": "Frame Scene",
	"help.action.reset-camera": "Reset Camera",
	"help.action.orbit-mode": "Orbit Mode",
	"help.action.fly-mode": "Fly Mode",
	"help.action.toggle-walk": "Toggle Walk",
	"help.action.toggle-gaming": "Toggle Gaming Controls",
	"help.action.show-collision": "Show Collision",
	"help.action.play-pause": "Play / Pause",
	"help.action.toggle-controls": "Toggle Controls",
	"help.action.toggle-help": "Toggle Info",
	"help.action.exit-cancel": "Exit / Cancel",
	"help.action.release-mouse": "Release Mouse",
	"help.action.exit-walk": "Exit Walk",
	"help.key.double-tap": "Double-tap",
	"help.key.tap": "Tap",
	"help.key.touch-drag": "Touch + Drag",
	"help.key.one-finger-drag": "One Finger Drag",
	"help.key.two-finger-drag": "Two Finger Drag",
	"help.key.pinch": "Pinch",
	"help.key.pinch-two-finger": "Pinch / Two Finger Drag",
	"help.key.joystick": "Joystick",
	"help.key.space": "Space",
	"help.key.esc": "Esc",
	"xr-modal.title": "WebGL Required",
	"xr-modal.message": "AR and VR are not supported on the WebGPU renderer. Pressing OK will reload the viewer with WebGL.",
	"xr-modal.cancel": "Cancel",
	"xr-modal.ok": "OK"
};

var esJson = {
	"settings.performance-mode": "Modo rendimiento",
	"settings.gaming-controls": "Controles de juego",
	"settings.show-annotations": "Mostrar anotaciones",
	"settings.show-collision": "Mostrar colisión",
	"settings.frame": "Encuadrar",
	"settings.reset": "Restablecer",
	"tooltip.play": "Reproducir",
	"tooltip.pause": "Pausar",
	"tooltip.orbit-camera": "Cámara orbital",
	"tooltip.fly-camera": "Cámara de vuelo",
	"tooltip.walk-mode": "Modo caminar",
	"tooltip.reset-camera": "Restablecer cámara",
	"tooltip.frame-scene": "Encuadrar escena",
	"tooltip.settings": "Ajustes",
	"tooltip.help": "Información",
	"tooltip.controls": "Controles",
	"tooltip.enter-ar": "Entrar en AR",
	"tooltip.enter-vr": "Entrar en VR",
	"tooltip.fullscreen": "Pantalla completa",
	"help.section.orbit": "Modo orbital",
	"help.section.fly": "Modo vuelo",
	"help.section.walk": "Modo caminar",
	"help.section.anim": "Animación",
	"help.section.modes": "Cambio de modo",
	"help.action.orbit": "Orbitar",
	"help.action.pan": "Desplazar",
	"help.action.zoom": "Zoom",
	"help.action.set-focus": "Fijar foco",
	"help.action.fly-to": "Volar a",
	"help.action.fly-to-point": "Volar al punto",
	"help.action.walk-to": "Caminar a",
	"help.action.look-around": "Mirar alrededor",
	"help.action.move": "Mover",
	"help.action.vertical": "Vertical",
	"help.action.jump": "Saltar",
	"help.action.run-slow": "Correr / Lento",
	"help.action.focus-point": "Punto focal",
	"help.action.frame-scene": "Encuadrar escena",
	"help.action.reset-camera": "Restablecer cámara",
	"help.action.orbit-mode": "Modo orbital",
	"help.action.fly-mode": "Modo vuelo",
	"help.action.toggle-walk": "Alternar caminar",
	"help.action.toggle-gaming": "Alternar controles de juego",
	"help.action.show-collision": "Mostrar colisión",
	"help.action.play-pause": "Reproducir / Pausar",
	"help.action.toggle-controls": "Alternar controles",
	"help.action.toggle-help": "Alternar información",
	"help.action.exit-cancel": "Salir / Cancelar",
	"help.action.release-mouse": "Liberar ratón",
	"help.action.exit-walk": "Salir de caminar",
	"help.key.double-tap": "Doble toque",
	"help.key.tap": "Toque",
	"help.key.touch-drag": "Toque + arrastrar",
	"help.key.one-finger-drag": "Arrastre con un dedo",
	"help.key.two-finger-drag": "Arrastre con dos dedos",
	"help.key.pinch": "Pellizcar",
	"help.key.pinch-two-finger": "Pellizcar / Arrastre con dos dedos",
	"help.key.joystick": "Joystick",
	"help.key.space": "Espacio",
	"help.key.esc": "Esc",
	"xr-modal.title": "Se requiere WebGL",
	"xr-modal.message": "AR y VR no son compatibles con el renderizador WebGPU. Al pulsar OK se recargará el visor con WebGL.",
	"xr-modal.cancel": "Cancelar",
	"xr-modal.ok": "OK"
};

var frJson = {
	"settings.performance-mode": "Mode performance",
	"settings.gaming-controls": "Commandes de jeu",
	"settings.show-annotations": "Afficher les annotations",
	"settings.show-collision": "Afficher les collisions",
	"settings.frame": "Cadrer",
	"settings.reset": "Réinitialiser",
	"tooltip.play": "Lecture",
	"tooltip.pause": "Pause",
	"tooltip.orbit-camera": "Caméra orbitale",
	"tooltip.fly-camera": "Caméra volante",
	"tooltip.walk-mode": "Mode marche",
	"tooltip.reset-camera": "Réinitialiser la caméra",
	"tooltip.frame-scene": "Cadrer la scène",
	"tooltip.settings": "Paramètres",
	"tooltip.help": "Infos",
	"tooltip.controls": "Commandes",
	"tooltip.enter-ar": "Entrer en AR",
	"tooltip.enter-vr": "Entrer en VR",
	"tooltip.fullscreen": "Plein écran",
	"help.section.orbit": "Mode orbital",
	"help.section.fly": "Mode vol",
	"help.section.walk": "Mode marche",
	"help.section.anim": "Animation",
	"help.section.modes": "Changement de mode",
	"help.action.orbit": "Orbiter",
	"help.action.pan": "Panoramique",
	"help.action.zoom": "Zoom",
	"help.action.set-focus": "Définir le focus",
	"help.action.fly-to": "Voler vers",
	"help.action.fly-to-point": "Voler vers le point",
	"help.action.walk-to": "Marcher vers",
	"help.action.look-around": "Regarder autour",
	"help.action.move": "Se déplacer",
	"help.action.vertical": "Vertical",
	"help.action.jump": "Sauter",
	"help.action.run-slow": "Courir / Lent",
	"help.action.focus-point": "Point focal",
	"help.action.frame-scene": "Cadrer la scène",
	"help.action.reset-camera": "Réinitialiser la caméra",
	"help.action.orbit-mode": "Mode orbital",
	"help.action.fly-mode": "Mode vol",
	"help.action.toggle-walk": "Basculer la marche",
	"help.action.toggle-gaming": "Basculer les commandes de jeu",
	"help.action.show-collision": "Afficher les collisions",
	"help.action.play-pause": "Lecture / Pause",
	"help.action.toggle-controls": "Basculer les commandes",
	"help.action.toggle-help": "Basculer les infos",
	"help.action.exit-cancel": "Quitter / Annuler",
	"help.action.release-mouse": "Libérer la souris",
	"help.action.exit-walk": "Quitter la marche",
	"help.key.double-tap": "Double tape",
	"help.key.tap": "Tape",
	"help.key.touch-drag": "Toucher + glisser",
	"help.key.one-finger-drag": "Glisser à un doigt",
	"help.key.two-finger-drag": "Glisser à deux doigts",
	"help.key.pinch": "Pincer",
	"help.key.pinch-two-finger": "Pincer / Glisser à deux doigts",
	"help.key.joystick": "Joystick",
	"help.key.space": "Espace",
	"help.key.esc": "Échap",
	"xr-modal.title": "WebGL requis",
	"xr-modal.message": "L'AR et la VR ne sont pas prises en charge par le moteur de rendu WebGPU. Cliquer sur OK rechargera le visualiseur avec WebGL.",
	"xr-modal.cancel": "Annuler",
	"xr-modal.ok": "OK"
};

var jaJson = {
	"settings.performance-mode": "パフォーマンスモード",
	"settings.gaming-controls": "ゲームコントロール",
	"settings.show-annotations": "注釈を表示",
	"settings.show-collision": "コリジョンを表示",
	"settings.frame": "フィット",
	"settings.reset": "リセット",
	"tooltip.play": "再生",
	"tooltip.pause": "一時停止",
	"tooltip.orbit-camera": "オービットカメラ",
	"tooltip.fly-camera": "フライカメラ",
	"tooltip.walk-mode": "ウォークモード",
	"tooltip.reset-camera": "カメラをリセット",
	"tooltip.frame-scene": "シーンにフィット",
	"tooltip.settings": "設定",
	"tooltip.help": "情報",
	"tooltip.controls": "操作",
	"tooltip.enter-ar": "ARを開始",
	"tooltip.enter-vr": "VRを開始",
	"tooltip.fullscreen": "全画面表示",
	"help.section.orbit": "オービットモード",
	"help.section.fly": "フライモード",
	"help.section.walk": "ウォークモード",
	"help.section.anim": "アニメーション",
	"help.section.modes": "モード切り替え",
	"help.action.orbit": "オービット",
	"help.action.pan": "パン",
	"help.action.zoom": "ズーム",
	"help.action.set-focus": "フォーカスを設定",
	"help.action.fly-to": "飛ぶ",
	"help.action.fly-to-point": "ポイントへ飛ぶ",
	"help.action.walk-to": "歩く",
	"help.action.look-around": "周りを見る",
	"help.action.move": "移動",
	"help.action.vertical": "垂直",
	"help.action.jump": "ジャンプ",
	"help.action.run-slow": "走る / 歩く",
	"help.action.focus-point": "フォーカスポイント",
	"help.action.frame-scene": "シーンにフィット",
	"help.action.reset-camera": "カメラをリセット",
	"help.action.orbit-mode": "オービットモード",
	"help.action.fly-mode": "フライモード",
	"help.action.toggle-walk": "ウォークを切り替え",
	"help.action.toggle-gaming": "ゲームコントロールを切り替え",
	"help.action.show-collision": "コリジョンを表示",
	"help.action.play-pause": "再生 / 一時停止",
	"help.action.toggle-controls": "操作の切り替え",
	"help.action.toggle-help": "情報を切り替え",
	"help.action.exit-cancel": "終了 / キャンセル",
	"help.action.release-mouse": "マウスを解放",
	"help.action.exit-walk": "ウォークを終了",
	"help.key.double-tap": "ダブルタップ",
	"help.key.tap": "タップ",
	"help.key.touch-drag": "タッチ + ドラッグ",
	"help.key.one-finger-drag": "1本指でドラッグ",
	"help.key.two-finger-drag": "2本指でドラッグ",
	"help.key.pinch": "ピンチ",
	"help.key.pinch-two-finger": "ピンチ / 2本指でドラッグ",
	"help.key.joystick": "ジョイスティック",
	"help.key.space": "スペース",
	"help.key.esc": "Esc",
	"xr-modal.title": "WebGLが必要です",
	"xr-modal.message": "ARとVRはWebGPUレンダラーでは利用できません。OKを押すとWebGLでビューアーを再読み込みします。",
	"xr-modal.cancel": "キャンセル",
	"xr-modal.ok": "OK"
};

var koJson = {
	"settings.performance-mode": "성능 모드",
	"settings.gaming-controls": "게임 컨트롤",
	"settings.show-annotations": "주석 표시",
	"settings.show-collision": "충돌 표시",
	"settings.frame": "맞춤",
	"settings.reset": "재설정",
	"tooltip.play": "재생",
	"tooltip.pause": "일시 정지",
	"tooltip.orbit-camera": "오빗 카메라",
	"tooltip.fly-camera": "플라이 카메라",
	"tooltip.walk-mode": "워크 모드",
	"tooltip.reset-camera": "카메라 재설정",
	"tooltip.frame-scene": "씬에 맞춤",
	"tooltip.settings": "설정",
	"tooltip.help": "정보",
	"tooltip.controls": "조작",
	"tooltip.enter-ar": "AR 시작",
	"tooltip.enter-vr": "VR 시작",
	"tooltip.fullscreen": "전체 화면",
	"help.section.orbit": "오빗 모드",
	"help.section.fly": "플라이 모드",
	"help.section.walk": "워크 모드",
	"help.section.anim": "애니메이션",
	"help.section.modes": "모드 전환",
	"help.action.orbit": "오빗",
	"help.action.pan": "팬",
	"help.action.zoom": "줌",
	"help.action.set-focus": "포커스 설정",
	"help.action.fly-to": "비행",
	"help.action.fly-to-point": "지점으로 비행",
	"help.action.walk-to": "걷기",
	"help.action.look-around": "둘러보기",
	"help.action.move": "이동",
	"help.action.vertical": "수직",
	"help.action.jump": "점프",
	"help.action.run-slow": "달리기 / 천천히",
	"help.action.focus-point": "포커스 포인트",
	"help.action.frame-scene": "씬에 맞춤",
	"help.action.reset-camera": "카메라 재설정",
	"help.action.orbit-mode": "오빗 모드",
	"help.action.fly-mode": "플라이 모드",
	"help.action.toggle-walk": "워크 전환",
	"help.action.toggle-gaming": "게임 컨트롤 전환",
	"help.action.show-collision": "충돌 표시",
	"help.action.play-pause": "재생 / 일시 정지",
	"help.action.toggle-controls": "조작 전환",
	"help.action.toggle-help": "정보 전환",
	"help.action.exit-cancel": "나가기 / 취소",
	"help.action.release-mouse": "마우스 해제",
	"help.action.exit-walk": "워크 종료",
	"help.key.double-tap": "더블 탭",
	"help.key.tap": "탭",
	"help.key.touch-drag": "터치 + 드래그",
	"help.key.one-finger-drag": "한 손가락 드래그",
	"help.key.two-finger-drag": "두 손가락 드래그",
	"help.key.pinch": "핀치",
	"help.key.pinch-two-finger": "핀치 / 두 손가락 드래그",
	"help.key.joystick": "조이스틱",
	"help.key.space": "스페이스",
	"help.key.esc": "Esc",
	"xr-modal.title": "WebGL 필요",
	"xr-modal.message": "AR과 VR은 WebGPU 렌더러에서 지원되지 않습니다. 확인을 누르면 WebGL로 뷰어를 다시 불러옵니다.",
	"xr-modal.cancel": "취소",
	"xr-modal.ok": "확인"
};

var ptBRJson = {
	"settings.performance-mode": "Modo de desempenho",
	"settings.gaming-controls": "Controles de jogo",
	"settings.show-annotations": "Mostrar anotações",
	"settings.show-collision": "Mostrar colisão",
	"settings.frame": "Enquadrar",
	"settings.reset": "Redefinir",
	"tooltip.play": "Reproduzir",
	"tooltip.pause": "Pausar",
	"tooltip.orbit-camera": "Câmera orbital",
	"tooltip.fly-camera": "Câmera de voo",
	"tooltip.walk-mode": "Modo caminhar",
	"tooltip.reset-camera": "Redefinir câmera",
	"tooltip.frame-scene": "Enquadrar cena",
	"tooltip.settings": "Configurações",
	"tooltip.help": "Informações",
	"tooltip.controls": "Controles",
	"tooltip.enter-ar": "Entrar em AR",
	"tooltip.enter-vr": "Entrar em VR",
	"tooltip.fullscreen": "Tela cheia",
	"help.section.orbit": "Modo orbital",
	"help.section.fly": "Modo voo",
	"help.section.walk": "Modo caminhar",
	"help.section.anim": "Animação",
	"help.section.modes": "Troca de modo",
	"help.action.orbit": "Orbitar",
	"help.action.pan": "Deslocar",
	"help.action.zoom": "Zoom",
	"help.action.set-focus": "Definir foco",
	"help.action.fly-to": "Voar para",
	"help.action.fly-to-point": "Voar até o ponto",
	"help.action.walk-to": "Caminhar para",
	"help.action.look-around": "Olhar em volta",
	"help.action.move": "Mover",
	"help.action.vertical": "Vertical",
	"help.action.jump": "Pular",
	"help.action.run-slow": "Correr / Devagar",
	"help.action.focus-point": "Ponto focal",
	"help.action.frame-scene": "Enquadrar cena",
	"help.action.reset-camera": "Redefinir câmera",
	"help.action.orbit-mode": "Modo orbital",
	"help.action.fly-mode": "Modo voo",
	"help.action.toggle-walk": "Alternar caminhar",
	"help.action.toggle-gaming": "Alternar controles de jogo",
	"help.action.show-collision": "Mostrar colisão",
	"help.action.play-pause": "Reproduzir / Pausar",
	"help.action.toggle-controls": "Alternar controles",
	"help.action.toggle-help": "Alternar informações",
	"help.action.exit-cancel": "Sair / Cancelar",
	"help.action.release-mouse": "Liberar mouse",
	"help.action.exit-walk": "Sair da caminhada",
	"help.key.double-tap": "Toque duplo",
	"help.key.tap": "Toque",
	"help.key.touch-drag": "Toque + arrastar",
	"help.key.one-finger-drag": "Arrastar com um dedo",
	"help.key.two-finger-drag": "Arrastar com dois dedos",
	"help.key.pinch": "Pinçar",
	"help.key.pinch-two-finger": "Pinçar / Arrastar com dois dedos",
	"help.key.joystick": "Joystick",
	"help.key.space": "Espaço",
	"help.key.esc": "Esc",
	"xr-modal.title": "WebGL necessário",
	"xr-modal.message": "AR e VR não são compatíveis com o renderizador WebGPU. Ao pressionar OK, o visualizador será recarregado com WebGL.",
	"xr-modal.cancel": "Cancelar",
	"xr-modal.ok": "OK"
};

var ruJson = {
	"settings.performance-mode": "Режим производительности",
	"settings.gaming-controls": "Игровое управление",
	"settings.show-annotations": "Показать аннотации",
	"settings.show-collision": "Показать коллизию",
	"settings.frame": "Кадрировать",
	"settings.reset": "Сбросить",
	"tooltip.play": "Воспроизвести",
	"tooltip.pause": "Пауза",
	"tooltip.orbit-camera": "Орбитальная камера",
	"tooltip.fly-camera": "Полётная камера",
	"tooltip.walk-mode": "Режим ходьбы",
	"tooltip.reset-camera": "Сбросить камеру",
	"tooltip.frame-scene": "Кадрировать сцену",
	"tooltip.settings": "Настройки",
	"tooltip.help": "Информация",
	"tooltip.controls": "Управление",
	"tooltip.enter-ar": "Войти в AR",
	"tooltip.enter-vr": "Войти в VR",
	"tooltip.fullscreen": "Полный экран",
	"help.section.orbit": "Орбитальный режим",
	"help.section.fly": "Режим полёта",
	"help.section.walk": "Режим ходьбы",
	"help.section.anim": "Анимация",
	"help.section.modes": "Смена режимов",
	"help.action.orbit": "Вращение",
	"help.action.pan": "Панорама",
	"help.action.zoom": "Масштаб",
	"help.action.set-focus": "Задать фокус",
	"help.action.fly-to": "Лететь к",
	"help.action.fly-to-point": "Лететь к точке",
	"help.action.walk-to": "Идти к",
	"help.action.look-around": "Осмотреться",
	"help.action.move": "Движение",
	"help.action.vertical": "Вертикально",
	"help.action.jump": "Прыжок",
	"help.action.run-slow": "Бег / Медленно",
	"help.action.focus-point": "Точка фокуса",
	"help.action.frame-scene": "Кадрировать сцену",
	"help.action.reset-camera": "Сбросить камеру",
	"help.action.orbit-mode": "Орбитальный режим",
	"help.action.fly-mode": "Режим полёта",
	"help.action.toggle-walk": "Переключить ходьбу",
	"help.action.toggle-gaming": "Переключить игровое управление",
	"help.action.show-collision": "Показать коллизию",
	"help.action.play-pause": "Воспроизведение / Пауза",
	"help.action.toggle-controls": "Переключить управление",
	"help.action.toggle-help": "Переключить информацию",
	"help.action.exit-cancel": "Выход / Отмена",
	"help.action.release-mouse": "Освободить мышь",
	"help.action.exit-walk": "Выйти из ходьбы",
	"help.key.double-tap": "Двойной тап",
	"help.key.tap": "Тап",
	"help.key.touch-drag": "Касание + перетаскивание",
	"help.key.one-finger-drag": "Перетаскивание одним пальцем",
	"help.key.two-finger-drag": "Перетаскивание двумя пальцами",
	"help.key.pinch": "Щипок",
	"help.key.pinch-two-finger": "Щипок / Перетаскивание двумя пальцами",
	"help.key.joystick": "Джойстик",
	"help.key.space": "Пробел",
	"help.key.esc": "Esc",
	"xr-modal.title": "Требуется WebGL",
	"xr-modal.message": "AR и VR не поддерживаются рендером WebGPU. Нажмите OK, чтобы перезагрузить просмотрщик с WebGL.",
	"xr-modal.cancel": "Отмена",
	"xr-modal.ok": "OK"
};

var zhCNJson = {
	"settings.performance-mode": "性能模式",
	"settings.gaming-controls": "游戏控制",
	"settings.show-annotations": "显示注释",
	"settings.show-collision": "显示碰撞",
	"settings.frame": "适应",
	"settings.reset": "重置",
	"tooltip.play": "播放",
	"tooltip.pause": "暂停",
	"tooltip.orbit-camera": "环绕相机",
	"tooltip.fly-camera": "飞行相机",
	"tooltip.walk-mode": "行走模式",
	"tooltip.reset-camera": "重置相机",
	"tooltip.frame-scene": "适应场景",
	"tooltip.settings": "设置",
	"tooltip.help": "信息",
	"tooltip.controls": "操作",
	"tooltip.enter-ar": "进入 AR",
	"tooltip.enter-vr": "进入 VR",
	"tooltip.fullscreen": "全屏",
	"help.section.orbit": "环绕模式",
	"help.section.fly": "飞行模式",
	"help.section.walk": "行走模式",
	"help.section.anim": "动画",
	"help.section.modes": "模式切换",
	"help.action.orbit": "环绕",
	"help.action.pan": "平移",
	"help.action.zoom": "缩放",
	"help.action.set-focus": "设置焦点",
	"help.action.fly-to": "飞至",
	"help.action.fly-to-point": "飞至该点",
	"help.action.walk-to": "走到",
	"help.action.look-around": "环顾",
	"help.action.move": "移动",
	"help.action.vertical": "垂直",
	"help.action.jump": "跳跃",
	"help.action.run-slow": "奔跑 / 慢走",
	"help.action.focus-point": "焦点",
	"help.action.frame-scene": "适应场景",
	"help.action.reset-camera": "重置相机",
	"help.action.orbit-mode": "环绕模式",
	"help.action.fly-mode": "飞行模式",
	"help.action.toggle-walk": "切换行走",
	"help.action.toggle-gaming": "切换游戏控制",
	"help.action.show-collision": "显示碰撞",
	"help.action.play-pause": "播放 / 暂停",
	"help.action.toggle-controls": "切换操作",
	"help.action.toggle-help": "切换信息",
	"help.action.exit-cancel": "退出 / 取消",
	"help.action.release-mouse": "释放鼠标",
	"help.action.exit-walk": "退出行走",
	"help.key.double-tap": "双击",
	"help.key.tap": "点击",
	"help.key.touch-drag": "触摸 + 拖动",
	"help.key.one-finger-drag": "单指拖动",
	"help.key.two-finger-drag": "双指拖动",
	"help.key.pinch": "捏合",
	"help.key.pinch-two-finger": "捏合 / 双指拖动",
	"help.key.joystick": "摇杆",
	"help.key.space": "空格",
	"help.key.esc": "Esc",
	"xr-modal.title": "需要 WebGL",
	"xr-modal.message": "WebGPU 渲染器不支持 AR 和 VR。按下确定将以 WebGL 重新加载查看器。",
	"xr-modal.cancel": "取消",
	"xr-modal.ok": "确定"
};

const en = enJson;
const dictionaries = {
    de: deJson,
    en,
    es: esJson,
    fr: frJson,
    ja: jaJson,
    ko: koJson,
    'pt-BR': ptBRJson,
    ru: ruJson,
    'zh-CN': zhCNJson
};
const detectLocale = (lang) => {
    const candidates = [lang, ...(navigator.languages ?? [navigator.language])];
    const keys = Object.keys(dictionaries);
    for (const c of candidates) {
        if (!c)
            continue;
        const lc = c.toLowerCase();
        const base = lc.split('-')[0];
        // 1. exact tag match (case-insensitive: "DE" → "de", "pt-br" → "pt-BR")
        // 2. base-language match ("fr-CA" → "fr")
        // 3. any region variant sharing the base ("pt" → "pt-BR", "zh" → "zh-CN")
        const match = keys.find((k) => k.toLowerCase() === lc) ??
            keys.find((k) => k.toLowerCase() === base) ??
            keys.find((k) => k.toLowerCase().split('-')[0] === base);
        if (match)
            return match;
    }
    return 'en';
};
// Detect the preferred locale and replace the text of every `[data-i18n]`
// element under `root` with its translation, then return the lookup for that
// locale so ui code can localize strings at runtime. Per instance rather than
// module state, so two viewers on a page can differ. The locale is recorded as
// the root's `lang` so the browser picks fonts for that language (CJK glyph
// selection depends on it) without the viewer touching the document's own.
const initLocalization = (lang, root) => {
    const locale = detectLocale(lang);
    const current = dictionaries[locale];
    // fall back to English, then the key itself so missing translations are
    // visible rather than blank
    const localize = (key) => current[key] ?? en[key] ?? key;
    root.lang = locale;
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = localize(el.dataset.i18n);
    });
    return localize;
};

const readPreferences = (mobile) => {
    const defaults = { performanceMode: mobile, gamingControls: false, showAnnotations: true };
    try {
        // Preserve the legacy preference migration and origin-wide keys.
        const legacyRetina = localStorage.getItem('retinaDisplay');
        let performanceMode = localStorage.getItem('performanceMode');
        if (legacyRetina !== null && performanceMode === null) {
            performanceMode = String(legacyRetina === 'false');
            try {
                localStorage.setItem('performanceMode', performanceMode);
                localStorage.removeItem('retinaDisplay');
            }
            catch {
                // Keep the migrated runtime value even if storage cannot be updated.
            }
        }
        return {
            performanceMode: performanceMode === null ? mobile : performanceMode === 'true',
            gamingControls: localStorage.getItem('gamingControls') === 'true',
            showAnnotations: localStorage.getItem('showAnnotations') !== 'false'
        };
    }
    catch {
        // Embedded documents can be denied storage. Preferences must not prevent viewing.
        return defaults;
    }
};
const persistPreferences = (events) => {
    // Write changes only, so creating a viewer does not persist platform defaults.
    const subscriptions = ['performanceMode', 'gamingControls', 'showAnnotations'].map((key) => events.on(`${key}:changed`, (value) => {
        try {
            localStorage.setItem(key, String(value));
        }
        catch {
            // Storage may be blocked or full; runtime state still takes effect.
        }
    }));
    return () => subscriptions.forEach((subscription) => subscription.off());
};

// The single source of default experience settings, so every tool that writes a settings file
// agrees. Several independent copies of these values had drifted apart; these are the ones
// matching the settings already published in the wild, which means some producers change:
// `tonemapping` is 'linear' rather than 'none', `background.color` is black rather than 0.4
// grey, `bloom.intensity` is 0.1 rather than 1 (1 falls outside the authoring range in
// ranges.ts) and `grading.brightness` is 1 rather than 0.
// Frozen: `defaultSettings()` copies this, so a consumer mutating it would otherwise change
// every later call's result.
/** Default page and scene background, as normalized 0..1 rgb components. */
/** Default vertical field of view, in degrees. */
// Annotated so the published declaration widens to `number`; without it the emitted type is
// the literal `75`, which bakes the value into the api.
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
const DEFAULT_CAMERA_FOV = 85;
/**
 * Default post-processing settings, with every effect disabled.
 *
 * @returns A fresh object; callers may mutate it freely.
 */
const defaultPostEffectSettings = () => ({
    sharpness: {
        enabled: false,
        amount: 0
    },
    bloom: {
        enabled: false,
        intensity: 0.1,
        blurLevel: 2
    },
    grading: {
        enabled: false,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        tint: [1, 1, 1]
    },
    vignette: {
        enabled: false,
        intensity: 0.5,
        inner: 0.3,
        outer: 0.75,
        curvature: 1
    },
    fringing: {
        enabled: false,
        intensity: 0.5
    }
});

// Authoring bounds for experience settings, shared by the settings validators and by editor
// UIs that need slider ranges. Pure data with no imports, so a consumer can take these
// without pulling in the schema.
//
// These are *authoring* limits, not read limits: the viewer renders values outside them
// perfectly well, and settings in the wild contain some (see validate-limits.ts).
// `step` is UI granularity, not a constraint.
// These are published constants that the validators themselves read, so a consumer mutating
// one would silently change validation for everyone in the realm. Freeze rather than rely on
// `as const`, which is erased at runtime.
const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
};
/** Bounds for a camera's vertical field of view, in degrees. */
deepFreeze({
    min: 10,
    max: 120,
    step: 1
});
/** Bounds for each post-processing parameter. */
deepFreeze({
    sharpness: {
        amount: { min: 0, max: 1, step: 0.01 }
    },
    bloom: {
        intensity: { min: 0, max: 0.1, step: 0.01 },
        blurLevel: { min: 1, max: 16, step: 1 }
    },
    grading: {
        brightness: { min: 0, max: 3, step: 0.01 },
        contrast: { min: 0.5, max: 1.5, step: 0.01 },
        saturation: { min: 0, max: 2, step: 0.01 }
    },
    vignette: {
        intensity: { min: 0, max: 1, step: 0.01 },
        inner: { min: 0, max: 3, step: 0.01 },
        outer: { min: 0, max: 3, step: 0.01 },
        curvature: { min: 0.01, max: 10, step: 0.01 }
    },
    fringing: {
        intensity: { min: 0, max: 100, step: 1 }
    }
});
// Annotated rather than `as const`: the annotation keeps them readonly while widening the
// values, so the published types do not bake in numbers we may want to relax later.
/** Bounds and size limits for camera animation tracks. Intentionally tight for now. */
deepFreeze({
    duration: { min: 0.1, max: 600 },
    frameRate: { min: 1, max: 120 },
    smoothness: { min: 0, max: 1 },
    maxKeyframes: 1000,
    nameMax: 120,
    maxTracks: 10
});
/** Size limits for annotations. Intentionally tight for now. */
deepFreeze({
    maxCount: 25,
    titleMax: 60,
    textMax: 280
});

const migrateV1 = (input) => {
    // Copy first: callers own the object they pass in, and an API consumer holding a
    // reference should not see it rewritten underneath them.
    const settings = structuredClone(input);
    if (settings.animTracks) {
        settings.animTracks?.forEach((track) => {
            // some early settings did not have frameRate set on anim tracks
            if (!track.frameRate) {
                const defaultFrameRate = 30;
                track.frameRate = defaultFrameRate;
                const times = track.keyframes.times;
                for (let i = 0; i < times.length; i++) {
                    times[i] *= defaultFrameRate;
                }
            }
            // smoothness property added in v1.4.0
            // eslint-disable-next-line no-prototype-builtins -- preserve property lookup semantics
            if (!track.hasOwnProperty('smoothness')) {
                track.smoothness = 0;
            }
        });
    }
    else {
        // some scenes were published without animTracks
        settings.animTracks = [];
    }
    return settings;
};
const migrateAnimTrackV2 = (animTrackV1, fov) => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
            }
        }
    };
};
const migrateV2 = (v1) => {
    return {
        version: 2,
        // Not the shared default ('linear'): tonemapping applies unconditionally, so changing
        // it here would alter how existing v1 content renders.
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color || [0, 0, 0]
        },
        // Shared defaults rather than a private copy, so a migrated document lands inside the
        // authoring bounds and `validateSettings(v1, { limits: true })` reports the caller's
        // data instead of values invented here. Every effect is `enabled: false`, so which
        // numbers they carry is inert.
        postEffectSettings: defaultPostEffectSettings(),
        animTracks: v1.animTracks.map((animTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || DEFAULT_CAMERA_FOV);
        }),
        cameras: v1.camera.position && v1.camera.target
            ? [
                {
                    initial: {
                        position: v1.camera.position,
                        target: v1.camera.target,
                        fov: v1.camera.fov || DEFAULT_CAMERA_FOV
                    }
                }
            ]
            : [],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default'
    };
};
/**
 * Migrate settings of any supported version to the latest schema.
 *
 * Assumes valid input — call {@link validateSettings} first if the source is untrusted. Does
 * not mutate the object passed in.
 *
 * @param settings - Parsed contents of a settings file.
 * @returns The settings at the latest version.
 * @throws If the version is not supported.
 */
const importSettings = (settings) => {
    let result;
    const version = settings.version;
    if (version === undefined) {
        // v1 -> v2
        result = migrateV2(migrateV1(settings));
    }
    else if (version === 2) {
        // already v2
        result = settings;
    }
    else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
    return result;
};

var version = "1.37.0";

class Tooltip {
    register;
    unregister;
    destroy;
    constructor(dom) {
        const { style } = dom;
        style.display = 'none';
        const targets = new Map();
        let timer = 0;
        this.register = (target, textString, direction = 'bottom') => {
            const activate = () => {
                // the tooltip is positioned within the ui layer, so express the target's
                // viewport rect in that layer's coordinates
                const origin = dom.parentElement.getBoundingClientRect();
                const rect = target.getBoundingClientRect();
                const left = rect.left - origin.left;
                const right = rect.right - origin.left;
                const top = rect.top - origin.top;
                const bottom = rect.bottom - origin.top;
                const midx = Math.floor((left + right) * 0.5);
                const midy = Math.floor((top + bottom) * 0.5);
                switch (direction) {
                    case 'left':
                        style.left = `${left}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(calc(-100% - 10px), -50%)';
                        break;
                    case 'right':
                        style.left = `${right}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(10px, -50%)';
                        break;
                    case 'top':
                        style.left = `${midx}px`;
                        style.top = `${top}px`;
                        style.transform = 'translate(-50%, calc(-100% - 10px))';
                        break;
                    case 'bottom':
                        style.left = `${midx}px`;
                        style.top = `${bottom}px`;
                        style.transform = 'translate(-50%, 10px)';
                        break;
                }
                dom.textContent = textString;
                style.display = 'inline';
            };
            const startTimer = (fn) => {
                timer = window.setTimeout(() => {
                    fn();
                    timer = -1;
                }, 250);
            };
            const cancelTimer = () => {
                if (timer >= 0) {
                    clearTimeout(timer);
                    timer = -1;
                }
            };
            const enter = () => {
                cancelTimer();
                if (style.display === 'inline') {
                    activate();
                }
                else {
                    startTimer(() => activate());
                }
            };
            const leave = () => {
                cancelTimer();
                if (style.display === 'inline') {
                    startTimer(() => {
                        style.display = 'none';
                    });
                }
            };
            target.addEventListener('pointerenter', enter);
            target.addEventListener('pointerleave', leave);
            targets.set(target, { enter, leave });
        };
        this.unregister = (target) => {
            const value = targets.get(target);
            if (value) {
                target.removeEventListener('pointerenter', value.enter);
                target.removeEventListener('pointerleave', value.leave);
                targets.delete(target);
            }
        };
        this.destroy = () => {
            for (const target of targets.keys()) {
                this.unregister(target);
            }
        };
    }
}

const initAnnotationControls = (viewer, root) => {
    const { state, events, annotations } = viewer;
    const nav = root.querySelector('.sse-annotationNav');
    const info = root.querySelector('.sse-annotationInfo');
    const number = root.querySelector('.sse-annotationNavNumber');
    const title = root.querySelector('.sse-annotationNavTitle');
    const prev = root.querySelector('.sse-annotationPrev');
    const next = root.querySelector('.sse-annotationNext');
    const row = root.querySelector('.sse-annotationsRow');
    const check = root.querySelector('.sse-annotationsCheck');
    // Retain the last title and navigation position when the panel is dismissed, greyed out
    // while nothing is selected so it does not read as the selection; clicking it selects it.
    let currentIndex = state.selectedAnnotation ?? 0;
    const update = () => {
        currentIndex = state.selectedAnnotation ?? currentIndex;
        // the number its hotspot shows in the scene
        number.textContent = annotations[currentIndex] ? String(currentIndex + 1) : '';
        title.textContent = annotations[currentIndex]?.title ?? '';
        nav.classList.toggle('sse-hidden', !state.loaded || !state.showAnnotations || annotations.length < 2);
        nav.classList.toggle('sse-unselected', state.selectedAnnotation === null);
        nav.classList.toggle('sse-desktop', state.inputMode === 'desktop');
        nav.classList.toggle('sse-touch', state.inputMode === 'touch');
        nav.classList.toggle('sse-faded-in', !state.controlsHidden);
        nav.classList.toggle('sse-faded-out', state.controlsHidden);
        prev.disabled = next.disabled = !state.loaded || annotations.length < 2;
        row.classList.toggle('sse-hidden', annotations.length === 0);
        check.classList.toggle('sse-active', state.showAnnotations);
    };
    const onPrev = (event) => {
        event.stopPropagation();
        viewer.selectAnnotation((currentIndex - 1 + annotations.length) % annotations.length);
    };
    const onNext = (event) => {
        event.stopPropagation();
        viewer.selectAnnotation((currentIndex + 1) % annotations.length);
    };
    const onInfo = (event) => {
        event.stopPropagation();
        if (state.loaded && state.selectedAnnotation === null && annotations[currentIndex]) {
            viewer.selectAnnotation(currentIndex);
        }
    };
    const onVisibility = (event) => {
        event.stopPropagation();
        state.showAnnotations = !state.showAnnotations;
    };
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    info.addEventListener('click', onInfo);
    row.addEventListener('click', onVisibility);
    const subscriptions = [
        events.on('loaded:changed', update),
        events.on('selectedAnnotation:changed', update),
        events.on('showAnnotations:changed', update),
        events.on('inputMode:changed', update),
        events.on('controlsHidden:changed', update)
    ];
    update();
    return () => {
        for (const subscription of subscriptions)
            subscription.off();
        prev.removeEventListener('click', onPrev);
        next.removeEventListener('click', onNext);
        info.removeEventListener('click', onInfo);
        row.removeEventListener('click', onVisibility);
    };
};

/**
 * Displacement-based inputs (mouse, touch, wheel, pinch) return accumulated
 * pixel offsets that already scale with frame time. This factor converts
 * rate-based speed constants (tuned for degrees-per-second) to work with
 * per-frame displacements, making them frame-rate-independent.
 */
const DISPLACEMENT_SCALE = 1 / 60;
/** Maximum accumulated touch movement (px) to still count as a tap. */
const TAP_EPSILON = 15;
const tmpHalfSize = new Vec3();
/**
 * Converts screen-space pixel deltas to a world-space pan vector at the
 * given depth.
 *
 * @param camera - The camera component.
 * @param dx - Horizontal pixel delta.
 * @param dy - Vertical pixel delta.
 * @param dz - Depth (world-space) at which to project the delta.
 * @param out - Optional output vector.
 * @returns The pan vector in world space.
 */
const screenToWorld = (camera, dx, dy, dz, out = new Vec3()) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;
    out.set(-(dx / width) * 2, (dy / height) * 2, 0);
    const halfSize = tmpHalfSize.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        if (horizontalFov) {
            halfSize.set(halfSlice, halfSlice / aspectRatio, 0);
        }
        else {
            halfSize.set(halfSlice * aspectRatio, halfSlice, 0);
        }
    }
    else {
        halfSize.set(orthoHeight * aspectRatio, orthoHeight, 0);
    }
    out.mul(halfSize);
    return out;
};
/**
 * The orbit camera and the fly camera disagree on the sign of the z-axis
 * for forward motion. Apply this when emitting a forward/back z-component
 * so the same wheel-style delta drives both cameras correctly.
 *
 * @param mode - The current camera mode.
 * @param z - The raw forward/back z-component.
 * @returns The z-component flipped for orbit mode, unchanged otherwise.
 */
const flipZForOrbit = (mode, z) => (mode === 'orbit' ? -z : z);

const vec$1 = new Vec3();
/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A hotspot: a dom circle with the annotation's number, kept over the annotation's position.
 * `Annotations` tests it against the scene and marks it occluded, which fades it rather than
 * letting the scene cover it pixel by pixel. It stays clickable either way.
 * - An annotation panel that shows title and description text, shared by every annotation.
 *
 * Styles live in `index.scss`, under `.sse-annotations`.
 */
class Annotation extends Script {
    static scriptName = 'annotation';
    /**
     * State shared by every annotation of one viewer. Set by `Annotations` before the script
     * initialises.
     */
    context;
    /**
     * @attribute
     */
    label;
    /**
     * @attribute
     */
    title;
    /**
     * @attribute
     */
    text;
    /**
     * @private
     */
    hotspotDom = null;
    /**
     * The hotspot's position in canvas pixels, its distance from the camera and its depth
     * along the view, as of the last update; null while it is behind the camera. Read by the
     * occlusion test.
     * @private
     */
    screen = null;
    /**
     * Set once the entity is destroyed, so a prerender still queued for this frame does not
     * touch torn-down state.
     * @private
     */
    destroyed = false;
    initialize() {
        const ctx = this.context;
        this.hotspotDom = document.createElement('div');
        // dimmed until the occlusion test first shows it in view, rather than every hotspot
        // showing at full strength on the reveal and the hidden ones fading afterwards
        this.hotspotDom.className = 'sse-annotation-hotspot sse-occluded';
        this.hotspotDom.textContent = this.label;
        const onClick = (e) => {
            e.stopPropagation();
            this.fire('select');
        };
        this.hotspotDom.addEventListener('click', onClick);
        ctx.hotspotsDom.appendChild(this.hotspotDom);
        const onPrerender = () => this._update();
        this.app.on('prerender', onPrerender);
        // Clean up on entity destruction
        this.on('destroy', () => {
            this.destroyed = true;
            this.app.off('prerender', onPrerender);
            this.hotspotDom.removeEventListener('click', onClick);
            this.hotspotDom.remove();
            if (ctx.activeAnnotation === this) {
                this.hideTooltip();
            }
        });
    }
    /**
     * Update the screen-space elements for this annotation. Called each frame from the
     * prerender callback, and also directly from revealTooltip to ensure the tooltip is
     * positioned correctly even when the camera hasn't moved (e.g. annotations sharing the same
     * camera pose).
     * @private
     */
    _update() {
        if (this.destroyed)
            return;
        const { camera } = this.context;
        const position = this.entity.getPosition();
        camera.camera.viewMatrix.transformPoint(position, vec$1);
        if (vec$1.z >= 0) {
            this.screen = null;
            this._hideElements();
            return;
        }
        const screenPos = camera.camera.worldToScreen(position);
        const distance = camera.getPosition().distance(position);
        this.screen = { x: screenPos.x, y: screenPos.y, distance, depth: -vec$1.z };
        this._updatePositions(screenPos, distance);
    }
    /**
     * Mark the hotspot as hidden behind the scene, which fades it to a faint outline.
     * @param occluded - Whether scene content covers the annotation's position.
     * @private
     */
    setOccluded(occluded) {
        this.hotspotDom.classList.toggle('sse-occluded', occluded);
    }
    /**
     * Make this the annotation whose tooltip shows. The tooltip itself waits for the camera to
     * near the end of its move here, when `Annotations` calls `revealTooltip`, rather than
     * chasing the hotspot across the screen during the flight.
     * @private
     */
    showTooltip() {
        const ctx = this.context;
        ctx.activeAnnotation = this;
        ctx.revealed = false;
        this.hotspotDom.classList.add('sse-active');
    }
    /**
     * Show the tooltip beside this annotation, the camera being at or nearly at rest.
     * @private
     */
    revealTooltip() {
        const ctx = this.context;
        ctx.revealed = true;
        if (ctx.tooltipOwner !== this) {
            // taken over only now, so the tooltip fades out with the previous annotation's text,
            // beside its hotspot; and with no side yet, rather than the one it left it on
            ctx.tooltipOwner = this;
            ctx.titleDom.textContent = this.title;
            ctx.textDom.textContent = this.text;
            ctx.tooltipDom.classList.remove('sse-arrow-left', 'sse-arrow-right');
        }
        // the camera may be still, so no prerender may follow
        this._update();
    }
    /**
     * @private
     */
    hideTooltip() {
        const ctx = this.context;
        ctx.activeAnnotation = null;
        ctx.tooltipDom.classList.remove('sse-visible');
        this.hotspotDom.classList.remove('sse-active');
    }
    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (this.context.tooltipOwner === this) {
            this.context.tooltipDom.classList.remove('sse-visible');
        }
    }
    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @param {number} distance - Distance from the camera, which orders overlapping hotspots
     * @private
     */
    _updatePositions(screenPos, distance) {
        // Show and position hotspot; a transform rather than left/top, so moving it each frame
        // does not trigger layout
        const hotspot = this.hotspotDom;
        hotspot.style.display = 'flex';
        hotspot.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px) translate(-50%, -50%)`;
        // nearer hotspots draw over farther ones
        hotspot.style.zIndex = String(Math.round(100000 / (1 + distance)));
        const ctx = this.context;
        if (ctx.tooltipOwner !== this) {
            return;
        }
        // Shown while this annotation is selected and revealed, clamped to the canvas when the
        // hotspot is beyond it, so moving the camera yourself does not lose it. Hidden, it fades
        // out, moving with the hotspot at the offset it last had rather than standing still while
        // the camera moves on
        const tooltip = ctx.tooltipDom;
        const vw = ctx.canvas.clientWidth;
        const vh = ctx.canvas.clientHeight;
        const onCanvas = screenPos.x >= 0 && screenPos.x <= vw && screenPos.y >= 0 && screenPos.y <= vh;
        if (ctx.activeAnnotation !== this || !ctx.revealed) {
            tooltip.classList.remove('sse-visible');
            const offset = ctx.tooltipOffset;
            if (offset) {
                tooltip.style.transform = `translate(${screenPos.x + offset.x}px, ${screenPos.y + offset.y}px)`;
            }
            return;
        }
        // Position tooltip, clamped to the canvas (screenPos is in canvas pixels). Measured
        // before it is shown, which also lets a tooltip that was empty, and so not displayed,
        // fade in rather than appear at once
        const margin = 8;
        const arrowOffset = 24;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        // Beside the hotspot, vertically centered, on the side it is already on: changing sides
        // jumps it across the hotspot, so it does only when it no longer fits there and does on
        // the other side. With no side yet, the right unless that overflows
        const onRight = screenPos.x + arrowOffset;
        const onLeft = screenPos.x - arrowOffset - tw;
        let flipped = tooltip.classList.contains('sse-arrow-left');
        if (flipped ? onLeft < margin && onRight + tw <= vw - margin : onRight + tw > vw - margin) {
            flipped = !flipped;
        }
        let left = flipped ? onLeft : onRight;
        let top = screenPos.y - th / 2;
        // Clamp horizontal
        left = Math.max(margin, Math.min(left, vw - tw - margin));
        // Clamp vertical
        top = Math.max(margin, Math.min(top, vh - th - margin));
        // Position arrow to point at the hotspot, clamped within the tooltip
        const arrowY = Math.max(16, Math.min(screenPos.y - top, th - 16));
        tooltip.style.setProperty('--arrow-top', `${arrowY}px`);
        tooltip.classList.toggle('sse-arrow-right', !flipped);
        tooltip.classList.toggle('sse-arrow-left', flipped);
        tooltip.style.transform = `translate(${left}px, ${top}px)`;
        tooltip.classList.add('sse-visible');
        ctx.tooltipOffset = onCanvas ? { x: left - screenPos.x, y: top - screenPos.y } : null;
    }
}
/**
 * Everything the annotations of one viewer share: the dom they live in, the camera they follow,
 * the single tooltip, and the active bookkeeping. One per viewer, so two viewers on a page never
 * fight over shared state. Owned by `Annotations`, which removes `parentDom` on destroy.
 */
class AnnotationContext {
    parentDom;
    // the hotspots' own layer, beneath the tooltip: their depth ordering stays inside it, so
    // no hotspot can draw over the tooltip
    hotspotsDom;
    canvas;
    camera;
    tooltipDom;
    titleDom;
    textDom;
    activeAnnotation = null;
    // whether the active annotation's tooltip has been revealed: it hides for each camera
    // transition, the move to the annotation among them, until the transition nearly ends
    revealed = false;
    // the annotation the tooltip belongs to: the active one once revealed, until then the one
    // before it, beside whose hotspot it fades out. And its offset from that hotspot when it
    // last showed, which it keeps while fading; null when it last showed clamped to the canvas
    // with the hotspot beyond it, since it is not beside the hotspot, and then it fades in place
    tooltipOwner = null;
    tooltipOffset = null;
    constructor(canvas, camera, parentDom) {
        this.parentDom = parentDom;
        this.canvas = canvas;
        this.camera = camera;
        this.hotspotsDom = document.createElement('div');
        this.hotspotsDom.className = 'sse-annotation-hotspots';
        parentDom.appendChild(this.hotspotsDom);
        // the tooltip: the title, then the text. No number: the selected hotspot beside it
        // already shows it
        this.tooltipDom = document.createElement('div');
        this.tooltipDom.className = 'sse-annotation';
        this.titleDom = document.createElement('div');
        this.titleDom.className = 'sse-annotation-title';
        this.textDom = document.createElement('div');
        this.textDom.className = 'sse-annotation-text';
        this.tooltipDom.append(this.titleDom, this.textDom);
        parentDom.appendChild(this.tooltipDom);
    }
}

// how long the camera must be still before the hotspots are tested against the scene
const SETTLE_MS = 150;
// the scene in front of a hotspot must be at least this opaque to hide it, so haze does not
const OCCLUDING_OPACITY = 0.5;
// an annotation sits on the surface it describes, so the scene there is at about its depth;
// only content this much nearer than the annotation counts as in front of it. Relative, since
// the coarser detail streamed for a farther view thickens surfaces toward the camera
const OCCLUSION_TOLERANCE = 0.1;
// the hotspot's radius in css pixels: the opacity in front is averaged over its whole disc
const HOTSPOT_RADIUS = 13;
// the selected annotation's tooltip starts fading in once the camera has eased this far along
// a transition, its move there among them: the move settles slowly, so waiting for it to stop
// shows the tooltip well after the camera looks to have arrived
const REVEAL_PROGRESS = 0.9;
// Built-in hotspot and panel presentation. Selection and camera navigation belong to the viewer.
class Annotations {
    parentDom;
    parent;
    subscriptions;
    removeClick;
    removeOcclusion;
    constructor(viewer, root, camera, getPicker, getCameraProgress) {
        const { app, state, events, annotations } = viewer;
        const parentDom = document.createElement('div');
        parentDom.className = 'sse-annotations';
        // over the scene, beneath the ui
        root.querySelector('.sse-sceneLayer').appendChild(parentDom);
        this.parentDom = parentDom;
        const canvas = app.graphicsDevice.canvas;
        const context = new AnnotationContext(canvas, camera, parentDom);
        const parent = new Entity('annotations', app);
        app.root.addChild(parent);
        this.parent = parent;
        const scripts = [];
        for (let i = 0; i < annotations.length; i++) {
            const ann = annotations[i];
            const entity = new Entity('annotation', app);
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = entity.script.annotation;
            script.context = context;
            script.label = (i + 1).toString();
            script.title = ann.title;
            script.text = ann.text;
            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);
            parent.addChild(entity);
            scripts.push(script);
            script.on('select', () => viewer.selectAnnotation(i));
        }
        // Occlusion: a hotspot is either in front of the scene or behind it, never partly
        // covered. Once the camera has been still for a moment, pick the scene at every hotspot
        // on screen and fade the ones it covers; while the camera moves they keep their state.
        // One pick pass per stop, not per frame.
        let destroyed = false;
        let settleTimer = null;
        // bumped on every camera move, so a test that resolves after the camera moved again is
        // discarded rather than applied to a pose it was not taken from
        let pose = 0;
        const lastWorld = new Mat4();
        const lastProjection = new Mat4();
        const testOcclusion = async () => {
            settleTimer = null;
            const picker = getPicker();
            if (destroyed || !picker || parentDom.style.display === 'none')
                return;
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            const targets = scripts.filter(({ screen }) => {
                return screen && screen.x >= 0 && screen.x < width && screen.y >= 0 && screen.y < height;
            });
            if (targets.length === 0)
                return;
            const testedPose = pose;
            let opacities;
            try {
                opacities = await picker.pickVisibility(targets.map(({ screen }) => ({
                    x: screen.x / width,
                    y: screen.y / height,
                    depth: screen.depth * (1 - OCCLUSION_TOLERANCE)
                })), HOTSPOT_RADIUS / height);
            }
            catch {
                // a read-back that failed (a lost device, say): keep the hotspots as they are, and
                // the next camera stop or content change tests again
                return;
            }
            if (destroyed || testedPose !== pose)
                return;
            targets.forEach((script, i) => {
                script.setOccluded((opacities[i] ?? 0) >= OCCLUDING_OPACITY);
            });
        };
        const scheduleOcclusion = () => {
            if (settleTimer)
                clearTimeout(settleTimer);
            settleTimer = setTimeout(testOcclusion, SETTLE_MS);
        };
        // A new camera transition (a reset, say): the tooltip hides until it nearly ends, as on
        // the move to an annotation. Checked after the camera update but before the frame
        // renders, so the tooltip is not laid out for the transition's first frame
        let lastProgress = 1;
        const onFrameRender = () => {
            const progress = getCameraProgress();
            if (progress < lastProgress)
                context.revealed = false;
            lastProgress = progress;
        };
        app.on('framerender', onFrameRender);
        // after each frame, since the hotspots' screen positions are updated in prerender. The
        // camera entity's transform rather than its view matrix, which the engine refreshes only
        // for frames that render: the viewer skips a frame whose camera moved too little to see,
        // and a stale view matrix would pass for a camera at rest
        const onFrameEnd = () => {
            const world = camera.getWorldTransform();
            const { projectionMatrix } = camera.camera;
            const still = lastWorld.equals(world) && lastProjection.equals(projectionMatrix);
            const progress = getCameraProgress();
            // Show the selected annotation's tooltip once the camera is nearly there with the
            // hotspot on the canvas, fading in as the camera lands, or once the camera is at rest.
            // A hotspot that ends beyond the canvas gets its tooltip at rest, clamped to the edge,
            // rather than one that shows and then hides again as the hotspot slides off
            const { activeAnnotation } = context;
            const screen = activeAnnotation?.screen;
            const onCanvas = screen &&
                screen.x >= 0 &&
                screen.x <= canvas.clientWidth &&
                screen.y >= 0 &&
                screen.y <= canvas.clientHeight;
            if (activeAnnotation && !context.revealed && (still || (progress >= REVEAL_PROGRESS && onCanvas))) {
                activeAnnotation.revealTooltip();
            }
            if (still)
                return;
            lastWorld.copy(world);
            lastProjection.copy(projectionMatrix);
            pose++;
            scheduleOcclusion();
        };
        app.on('frameend', onFrameEnd);
        // The scene can change under a still camera: finer detail streams in after the reveal,
        // and after every move. The engine reports each frame whether all the detail it wants is
        // resident; when that turns true, new content has landed, so test again (the picker
        // drops its own cached render).
        const gsplatSystem = app.systems.gsplat;
        let contentReady = false;
        const onFrameReady = (frameCamera, _layer, ready) => {
            if (frameCamera !== camera.camera)
                return;
            if (ready && !contentReady) {
                pose++;
                scheduleOcclusion();
            }
            contentReady = ready;
        };
        gsplatSystem.on('frame:ready', onFrameReady);
        this.removeOcclusion = () => {
            destroyed = true;
            if (settleTimer)
                clearTimeout(settleTimer);
            app.off('framerender', onFrameRender);
            app.off('frameend', onFrameEnd);
            gsplatSystem.off('frame:ready', onFrameReady);
        };
        const update = () => {
            const firstPersonGamingControls = (state.cameraMode === 'walk' || state.cameraMode === 'fly') && state.gamingControls;
            const hidden = !state.loaded || !state.showAnnotations || state.controlsHidden || firstPersonGamingControls;
            const wasHidden = parentDom.style.display === 'none';
            parentDom.style.display = hidden ? 'none' : 'block';
            // hotspots coming back may have been covered or uncovered while hidden
            if (wasHidden && !hidden)
                scheduleOcclusion();
            const selected = hidden || state.selectedAnnotation === null ? null : scripts[state.selectedAnnotation];
            if (selected !== context.activeAnnotation) {
                context.activeAnnotation?.hideTooltip();
                selected?.showTooltip();
            }
            app.renderNextFrame = true;
        };
        this.subscriptions = [
            events.on('loaded:changed', update),
            events.on('selectedAnnotation:changed', update),
            events.on('controlsHidden:changed', update),
            events.on('showAnnotations:changed', update),
            events.on('cameraMode:changed', update),
            events.on('gamingControls:changed', update)
        ];
        update();
        // A click deselects, but a drag ends in a click too, so releasing an orbit would close
        // the tooltip. A press that moved farther than a tap may is a drag, as the navigation
        // clicks count it
        let pressMovement = 0;
        const onPointerDown = () => {
            pressMovement = 0;
        };
        const onPointerMove = (event) => {
            if (event.buttons)
                pressMovement += Math.abs(event.movementX) + Math.abs(event.movementY);
        };
        const onClick = () => {
            // consumed, so a later click from the keyboard is not taken for the drag
            const dragged = pressMovement >= TAP_EPSILON;
            pressMovement = 0;
            if (!dragged && state.loaded && state.selectedAnnotation !== null)
                viewer.selectAnnotation(null);
        };
        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('click', onClick);
        this.removeClick = () => {
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('click', onClick);
        };
    }
    destroy() {
        for (const subscription of this.subscriptions)
            subscription.off();
        this.removeClick();
        this.removeOcclusion();
        this.parent.destroy();
        this.parentDom.remove();
    }
}

const initCameraControls = (viewer, root) => {
    const { state, events } = viewer;
    const orbit = root.querySelector('.sse-orbitCamera');
    const fly = root.querySelector('.sse-flyCamera');
    const walk = root.querySelector('.sse-fpsCamera');
    const reset = root.querySelector('.sse-reset');
    const frame = root.querySelector('.sse-frame');
    const update = () => {
        orbit.classList.toggle('sse-active', state.cameraMode === 'orbit');
        fly.classList.toggle('sse-active', state.cameraMode === 'fly');
        walk.classList.toggle('sse-active', state.cameraMode === 'walk');
        walk.classList.toggle('sse-hidden', !state.walkAllowed);
        fly.classList.toggle('sse-middle', state.walkAllowed);
        fly.classList.toggle('sse-right', !state.walkAllowed);
        for (const button of [orbit, fly, walk, reset, frame]) {
            button.disabled = !state.loaded;
        }
    };
    const onOrbit = () => {
        state.cameraMode = 'orbit';
    };
    const onFly = () => {
        state.cameraMode = 'fly';
    };
    const onWalk = () => viewer.toggleWalk();
    const onReset = () => viewer.resetCamera();
    const onFrame = () => viewer.frameScene();
    orbit.addEventListener('click', onOrbit);
    fly.addEventListener('click', onFly);
    walk.addEventListener('click', onWalk);
    reset.addEventListener('click', onReset);
    frame.addEventListener('click', onFrame);
    const subscriptions = [
        events.on('cameraMode:changed', update),
        events.on('walkAllowed:changed', update),
        events.on('loaded:changed', update)
    ];
    update();
    return () => {
        for (const subscription of subscriptions)
            subscription.off();
        orbit.removeEventListener('click', onOrbit);
        fly.removeEventListener('click', onFly);
        walk.removeEventListener('click', onWalk);
        reset.removeEventListener('click', onReset);
        frame.removeEventListener('click', onFrame);
    };
};

// Whether the panel is open. New users see it open; once they close it, it stays closed.
const OPEN_KEY = 'controlsPanelOpen';
const readOpen = () => {
    try {
        return localStorage.getItem(OPEN_KEY) !== 'false';
    }
    catch {
        // Embedded documents can be denied storage.
        return true;
    }
};
const writeOpen = (open) => {
    try {
        localStorage.setItem(OPEN_KEY, String(open));
    }
    catch {
        // Storage may be blocked or full; the choice still holds for this viewer.
    }
};
const key = (label) => ({ kind: 'key', label });
const mouse = (button, suffix) => ({ kind: 'mouse', button, suffix });
// one line of keycaps rather than the studio's two-row cluster, so every row is the same height
const wasd = ['W', 'A', 'S', 'D'].map(key);
const or = { kind: 'or' };
// mouse outline with the pressed button filled, after the studio's navigation guide
const mouseButtonPaths = {
    left: '<path class="sse-mouseActive" d="M1 9a8 8 0 0 1 8-8v8Z"/>',
    right: '<path class="sse-mouseActive" d="M17 9a8 8 0 0 0-8-8v8Z"/>',
    wheel: '<rect class="sse-mouseActive" x="7.5" y="3.5" width="3" height="6" rx="1.5"/>',
    none: ''
};
const mouseSvg = (button) => '<svg class="sse-mouseIcon" viewBox="0 0 18 26" aria-hidden="true">' +
    `${mouseButtonPaths[button]}` +
    '<rect class="sse-mouseBody" x="1" y="1" width="16" height="24" rx="8"/>' +
    '<path class="sse-mouseSplit" d="M9 1v8M1 9h16"/>' +
    '</svg>';
const dragSvg = '<svg class="sse-dragIcon" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M6 1v10M1 6h10M4 3l2-2 2 2M4 9l2 2 2-2M3 4 1 6l2 2M9 4l2 2-2 2"/>' +
    '</svg>';
const titles = {
    orbit: 'help.section.orbit',
    fly: 'help.section.fly',
    walk: 'help.section.walk',
    anim: 'help.section.anim'
};
const icons = {
    orbit: '#orbitIcon',
    fly: '#flyIcon',
    walk: '#walkIcon',
    anim: '#playIcon'
};
// gaming controls (mouse capture on desktop, the joystick on touch) only apply to fly and walk
const isGaming = (state) => state.gamingControls && (state.cameraMode === 'fly' || state.cameraMode === 'walk');
// the controls for the viewer's current camera mode, input mode and gaming controls; no rows
// where there is nothing to list. Each list keeps the mouse rows together ahead of the keys
const describe = (state, localize) => {
    const { cameraMode } = state;
    const gaming = isGaming(state);
    const space = key(localize('help.key.space'));
    const esc = key(localize('help.key.esc'));
    const runSlow = ['run-slow', key('Shift'), or, key('Ctrl')];
    const reset = ['reset-camera', key('R')];
    const gesture = (name) => ({ kind: 'gesture', label: localize(`help.key.${name}`) });
    let rows;
    if (state.inputMode === 'desktop') {
        switch (cameraMode) {
            case 'orbit':
                rows = [
                    ['orbit', mouse('left', 'drag')],
                    ['pan', mouse('right', 'drag')],
                    ['zoom', mouse('wheel')],
                    ['set-focus', mouse('left')],
                    ['fly-to-point', mouse('left', 'double')],
                    ['frame-scene', key('F')],
                    reset
                ];
                break;
            case 'fly':
                rows = gaming
                    ? [
                        ['look-around', mouse('none', 'drag')],
                        ['move', ...wasd],
                        ['vertical', key('Q'), key('E')],
                        runSlow,
                        reset,
                        ['release-mouse', esc]
                    ]
                    : [
                        ['fly-to', mouse('left')],
                        ['look-around', mouse('left', 'drag')],
                        ['pan', mouse('right', 'drag')],
                        ['focus-point', mouse('left', 'double')],
                        ['move', ...wasd],
                        runSlow,
                        reset
                    ];
                break;
            case 'walk':
                rows = gaming
                    ? [
                        ['look-around', mouse('none', 'drag')],
                        ['move', ...wasd],
                        ['jump', space],
                        runSlow,
                        reset,
                        ['release-mouse', esc]
                    ]
                    : [
                        ['walk-to', mouse('left')],
                        ['look-around', mouse('left', 'drag')],
                        ['fly-to-point', mouse('left', 'double')],
                        ['move', ...wasd],
                        runSlow,
                        reset,
                        ['exit-walk', esc]
                    ];
                break;
            case 'anim':
                rows = [
                    ['play-pause', space],
                    ['exit-cancel', esc]
                ];
                break;
        }
        // not while the mouse is captured, where the ui closes the info box as soon as it opens
        if (!gaming) {
            rows.push(null, ['toggle-controls', key('H')], ['toggle-help', key('Shift'), key('H')]);
        }
    }
    else {
        switch (cameraMode) {
            case 'orbit':
                rows = [
                    ['orbit', gesture('one-finger-drag')],
                    ['pan', gesture('two-finger-drag')],
                    ['zoom', gesture('pinch')],
                    ['set-focus', gesture('tap')],
                    ['fly-to-point', gesture('double-tap')]
                ];
                break;
            case 'fly':
                rows = gaming
                    ? [
                        ['look-around', gesture('touch-drag')],
                        ['move', gesture('joystick')]
                    ]
                    : [
                        ['fly-to', gesture('tap')],
                        ['look-around', gesture('touch-drag')],
                        ['move', gesture('pinch-two-finger')],
                        ['focus-point', gesture('double-tap')]
                    ];
                break;
            case 'walk':
                rows = gaming
                    ? [
                        ['look-around', gesture('touch-drag')],
                        ['move', gesture('joystick')],
                        ['jump', gesture('tap')]
                    ]
                    : [
                        ['walk-to', gesture('tap')],
                        ['look-around', gesture('touch-drag')],
                        ['fly-to-point', gesture('double-tap')]
                    ];
                break;
            case 'anim':
                // the animation has no touch controls of its own: any touch takes over
                rows = [];
                break;
        }
    }
    return {
        title: localize(titles[cameraMode]),
        subtitle: gaming ? localize('settings.gaming-controls') : '',
        icon: icons[cameraMode],
        rows
    };
};
const renderToken = (token) => {
    const span = (className, text) => {
        const element = document.createElement('span');
        element.className = className;
        if (text)
            element.textContent = text;
        return element;
    };
    const kbd = (label) => {
        const element = document.createElement('kbd');
        element.className = 'sse-key';
        element.textContent = label;
        return element;
    };
    switch (token.kind) {
        case 'key':
            return kbd(token.label);
        case 'mouse': {
            const element = span('sse-mouse');
            // the mouse comes last, so every mouse lines up in the right-hand column like the
            // single keycaps. Constant markup only: nothing localized or external reaches innerHTML
            element.innerHTML = (token.suffix === 'drag' ? dragSvg : '') + mouseSvg(token.button);
            if (token.suffix === 'double')
                element.prepend(span('sse-mouseCount', '×2'));
            return element;
        }
        case 'gesture':
            return span('sse-gesture', token.label);
        case 'or':
            return span('sse-or', '/');
    }
};
/**
 * Fills the controls panel with the current camera mode and its controls, following the camera
 * mode, input mode and gaming controls (mouse capture on desktop). Opening and closing belong to
 * ui.ts, which toggles it from the toolbar like the settings and info panels.
 */
const initControlsHint = (viewer, root, localize) => {
    const { state, events } = viewer;
    const icon = root.querySelector('.sse-controlsHintIcon > use');
    const title = root.querySelector('.sse-controlsHintTitle');
    const subtitle = root.querySelector('.sse-controlsHintSubtitle');
    const rowsElement = root.querySelector('.sse-controlsHintRows');
    let rendered = '';
    const render = (hint) => {
        icon.setAttribute('href', hint.icon);
        title.textContent = hint.title;
        subtitle.textContent = hint.subtitle;
        rowsElement.replaceChildren(...hint.rows.map((row) => {
            const element = document.createElement('div');
            if (!row) {
                element.className = 'sse-divider';
                return element;
            }
            const [action, ...tokens] = row;
            const name = document.createElement('span');
            name.className = 'sse-controlsHintAction';
            name.textContent = localize(`help.action.${action}`);
            const inputs = document.createElement('span');
            inputs.className = 'sse-controlsHintInputs';
            inputs.append(...tokens.map(renderToken));
            element.className = 'sse-controlsHintItem';
            element.append(name, inputs);
            return element;
        }));
    };
    // re-render when the page changes; a state change that leaves it as it was (G in orbit)
    // renders nothing
    const update = () => {
        const signature = `${state.cameraMode}:${state.inputMode}:${isGaming(state)}`;
        if (signature !== rendered) {
            rendered = signature;
            render(describe(state, localize));
        }
    };
    const subscriptions = [
        events.on('cameraMode:changed', update),
        events.on('inputMode:changed', update),
        events.on('gamingControls:changed', update)
    ];
    update();
    return () => {
        for (const subscription of subscriptions)
            subscription.off();
    };
};

const initFullscreenControls = (viewer, root) => {
    const enter = root.querySelector('.sse-enterFullscreen');
    const exit = root.querySelector('.sse-exitFullscreen');
    const update = () => {
        enter.classList.toggle('sse-hidden', viewer.state.isFullscreen);
        exit.classList.toggle('sse-hidden', !viewer.state.isFullscreen);
    };
    // Permission and user-gesture failures leave the observed state unchanged.
    const request = () => {
        void viewer.requestFullscreen().catch(() => {
            /* browser rejected the request */
        });
    };
    const leave = () => {
        void viewer.exitFullscreen().catch(() => {
            /* browser rejected the exit */
        });
    };
    const orientationChanged = () => {
        if (screen.orientation.type.startsWith('landscape'))
            request();
        else
            leave();
    };
    enter.addEventListener('click', request);
    exit.addEventListener('click', leave);
    screen.orientation?.addEventListener('change', orientationChanged);
    const changed = viewer.events.on('isFullscreen:changed', update);
    update();
    return () => {
        changed.off();
        enter.removeEventListener('click', request);
        exit.removeEventListener('click', leave);
        screen.orientation?.removeEventListener('change', orientationChanged);
    };
};

const initJoystick = (viewer, root) => {
    const { state, events } = viewer;
    const dom = {
        joystickBase: root.querySelector('.sse-joystickBase'),
        joystick: root.querySelector('.sse-joystick')
    };
    let disposed = false;
    // Joystick dimensions (matches SCSS: base height=100, stick size=40)
    const joystickHeight = 100;
    const stickSize = 40;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 30px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 30px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 30px up or down from center
    // Joystick touch state
    let joystickPointerId = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward
    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode = '2d';
    // Double-tap detection for mode toggle
    let lastTapTime = 0;
    const stop = () => {
        const pointerId = joystickPointerId;
        joystickPointerId = null;
        joystickValueX = joystickValueY = 0;
        dom.joystick.style.top = `${stickCenterY}px`;
        dom.joystick.style.left = joystickMode === '2d' ? `${stickCenterX}px` : '8px';
        if (pointerId !== null) {
            if (!disposed)
                viewer.setMoveInput(0, 0);
            if (dom.joystickBase.hasPointerCapture(pointerId))
                dom.joystickBase.releasePointerCapture(pointerId);
        }
    };
    // Update joystick visibility based on camera mode and input mode
    const updateJoystickVisibility = () => {
        stop();
        if ((state.cameraMode === 'fly' || state.cameraMode === 'walk') &&
            state.inputMode === 'touch' &&
            state.gamingControls &&
            state.loaded &&
            state.xrMode === null) {
            dom.joystickBase.classList.remove('sse-hidden');
            dom.joystickBase.classList.toggle('sse-mode-2d', joystickMode === '2d');
            // Center the stick
            dom.joystick.style.top = `${stickCenterY}px`;
            if (joystickMode === '2d') {
                dom.joystick.style.left = `${stickCenterX}px`;
            }
            else {
                dom.joystick.style.left = '8px'; // Reset to 1D centered position
            }
        }
        else {
            dom.joystickBase.classList.add('sse-hidden');
        }
    };
    const subscriptions = ['cameraMode', 'inputMode', 'gamingControls', 'loaded', 'xrMode'].map((key) => events.on(`${key}:changed`, updateJoystickVisibility));
    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX, clientY) => {
        // the stylesheet places the base within the instance, so measure its centre rather
        // than assuming where the viewport put it
        const base = dom.joystickBase.getBoundingClientRect();
        const baseY = base.top + base.height / 2;
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;
        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;
        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = base.left + base.width / 2;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;
            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        }
        else {
            joystickValueX = 0;
        }
        viewer.setMoveInput(joystickValueX, -joystickValueY);
    };
    const start = (event) => {
        if (joystickPointerId !== null)
            return;
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        }
        else {
            lastTapTime = now;
        }
        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);
        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    };
    const move = (event) => {
        if (event.pointerId !== joystickPointerId)
            return;
        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    };
    const endJoystickTouch = (event) => {
        if (event.pointerId !== joystickPointerId)
            return;
        stop();
    };
    dom.joystickBase.addEventListener('pointerdown', start);
    dom.joystickBase.addEventListener('pointermove', move);
    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
    dom.joystickBase.addEventListener('lostpointercapture', endJoystickTouch);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    updateJoystickVisibility();
    return () => {
        disposed = true;
        stop(); // The input controller has already cleared movement during viewer destruction.
        for (const subscription of subscriptions)
            subscription.off();
        dom.joystickBase.removeEventListener('pointerdown', start);
        dom.joystickBase.removeEventListener('pointermove', move);
        dom.joystickBase.removeEventListener('pointerup', endJoystickTouch);
        dom.joystickBase.removeEventListener('pointercancel', endJoystickTouch);
        dom.joystickBase.removeEventListener('lostpointercapture', endJoystickTouch);
        window.removeEventListener('blur', stop);
        document.removeEventListener('visibilitychange', stop);
    };
};

// Playback presentation uses the same state and commands as an embedding host.
const initPlayback = (viewer, root, showUI) => {
    const { state, events } = viewer;
    const play = root.querySelector('.sse-play');
    const pause = root.querySelector('.sse-pause');
    const timeline = root.querySelector('.sse-timelineContainer');
    const handle = root.querySelector('.sse-handle');
    const time = root.querySelector('.sse-time');
    const available = () => state.loaded && state.hasAnimation;
    const updateControls = () => {
        const playing = state.cameraMode === 'anim' && !state.animationPaused;
        play.classList.toggle('sse-hidden', !available() || playing);
        pause.classList.toggle('sse-hidden', !available() || !playing);
        timeline.classList.toggle('sse-hidden', !available() || state.cameraMode !== 'anim');
    };
    const updateSlider = () => {
        const position = state.animationDuration > 0 ? (state.animationTime / state.animationDuration) * 100 : 0;
        handle.style.left = `${position}%`;
        time.style.left = `${position}%`;
        time.innerText = `${state.animationTime.toFixed(1)}s`;
    };
    const onPlay = () => {
        if (!available())
            return;
        state.cameraMode = 'anim';
        state.animationPaused = false;
    };
    const onPause = () => {
        if (!available())
            return;
        state.cameraMode = 'anim';
        state.animationPaused = true;
    };
    const scrub = (event) => {
        const rect = timeline.getBoundingClientRect();
        if (rect.width <= 0)
            return;
        const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        viewer.seek(state.animationDuration * fraction);
        showUI();
    };
    let pointerId = null;
    const onPointerDown = (event) => {
        if (pointerId !== null || event.button !== 0 || !available())
            return;
        state.animationPaused = true;
        scrub(event);
        pointerId = event.pointerId;
        timeline.setPointerCapture(pointerId);
        time.classList.remove('sse-hidden');
    };
    const onPointerMove = (event) => {
        if (event.pointerId === pointerId)
            scrub(event);
    };
    const endDrag = (event) => {
        if (event.pointerId !== pointerId)
            return;
        pointerId = null;
        time.classList.add('sse-hidden');
        if (timeline.hasPointerCapture(event.pointerId)) {
            timeline.releasePointerCapture(event.pointerId);
        }
        // Do not restore an old pause flag over a host's command during the drag.
    };
    play.addEventListener('click', onPlay);
    pause.addEventListener('click', onPause);
    timeline.addEventListener('pointerdown', onPointerDown);
    timeline.addEventListener('pointermove', onPointerMove);
    timeline.addEventListener('pointerup', endDrag);
    timeline.addEventListener('pointercancel', endDrag);
    timeline.addEventListener('lostpointercapture', endDrag);
    const subscriptions = [
        events.on('loaded:changed', updateControls),
        events.on('hasAnimation:changed', updateControls),
        events.on('cameraMode:changed', updateControls),
        events.on('animationPaused:changed', updateControls),
        events.on('animationTime:changed', updateSlider),
        events.on('animationDuration:changed', updateSlider)
    ];
    updateControls();
    updateSlider();
    return () => {
        for (const subscription of subscriptions)
            subscription.off();
        play.removeEventListener('click', onPlay);
        pause.removeEventListener('click', onPause);
        timeline.removeEventListener('pointerdown', onPointerDown);
        timeline.removeEventListener('pointermove', onPointerMove);
        timeline.removeEventListener('pointerup', endDrag);
        timeline.removeEventListener('pointercancel', endDrag);
        timeline.removeEventListener('lostpointercapture', endDrag);
        if (pointerId !== null && timeline.hasPointerCapture(pointerId)) {
            timeline.releasePointerCapture(pointerId);
        }
    };
};

const initXrControls = (viewer, root) => {
    const { state, events } = viewer;
    const ar = root.querySelector('.sse-arMode');
    const vr = root.querySelector('.sse-vrMode');
    const modal = root.querySelector('.sse-xrModal');
    const ok = root.querySelector('.sse-xrModalOk');
    const cancel = root.querySelector('.sse-xrModalCancel');
    const update = () => {
        ar.classList.toggle('sse-hidden', !state.hasAR);
        vr.classList.toggle('sse-hidden', !state.hasVR);
        ar.disabled = vr.disabled = !state.loaded || state.xrMode !== null;
    };
    const start = (mode) => {
        if (mode === 'ar' ? state.canStartAR : state.canStartVR) {
            void viewer.startXR(mode).catch(() => {
                // Browser permission failures leave the controls in their observed state.
            });
        }
        else if (mode === 'ar' ? state.hasAR : state.hasVR) {
            modal.classList.remove('sse-hidden');
        }
    };
    const startAR = () => start('ar');
    const startVR = () => start('vr');
    const hideModal = () => modal.classList.add('sse-hidden');
    const reloadWithWebgl = () => {
        const url = new URL(location.href);
        url.searchParams.set('webgl', '');
        location.replace(url.toString());
    };
    ar.addEventListener('click', startAR);
    vr.addEventListener('click', startVR);
    ok.addEventListener('click', reloadWithWebgl);
    cancel.addEventListener('click', hideModal);
    modal.addEventListener('pointerdown', hideModal);
    const subscriptions = [
        events.on('loaded:changed', update),
        events.on('hasAR:changed', update),
        events.on('hasVR:changed', update),
        events.on('xrMode:changed', update)
    ];
    update();
    return () => {
        for (const subscription of subscriptions)
            subscription.off();
        ar.removeEventListener('click', startAR);
        vr.removeEventListener('click', startVR);
        ok.removeEventListener('click', reloadWithWebgl);
        cancel.removeEventListener('click', hideModal);
        modal.removeEventListener('pointerdown', hideModal);
    };
};

// show the poster image over the hidden canvas, blurry at first and sharpening as loading
// progresses, until the first frame renders
const initPoster = (root, image, events) => {
    const poster = root.querySelector('.sse-poster');
    poster.style.setProperty('--poster-url', `url(${image.src})`);
    poster.style.display = 'block';
    poster.style.filter = 'blur(40px)';
    // the canvas inherits this from the root
    root.style.setProperty('--canvas-opacity', '0');
    events.on('loaded:changed', () => {
        poster.style.display = 'none';
        root.style.setProperty('--canvas-opacity', '1');
    });
    const blur = (progress) => {
        poster.style.filter = `blur(${Math.floor((100 - progress) * 0.4)}px)`;
    };
    events.on('progress:changed', blur);
};
// the gpu the renderer runs on, as the browser names it: the WebGPU adapter's description,
// or WebGL's unmasked renderer string. Empty where the browser withholds it
const getGpuName = (device) => {
    const { gpuAdapter, unmaskedRenderer } = device;
    const info = gpuAdapter?.info;
    if (info) {
        return info.description || [info.vendor, info.architecture, info.device].filter(Boolean).join(' / ');
    }
    return unmaskedRenderer ?? '';
};
// Returns a function that removes the listeners added outside the ui subtree (window,
// document, screen) and cancels pending timers. Listeners on the subtree's own elements are
// released with the elements.
// `getPicker` returns the viewer's picker once the scene has loaded, for the annotation
// occlusion test; `getCameraProgress` how far the camera's current move has eased, 1 when there
// is none, for the annotation tooltip's timing
const initUI = (global, viewer, getPicker, getCameraProgress) => {
    const { root, localize } = global;
    const { events, state } = viewer;
    const disposers = [];
    const on = (name, callback) => {
        const subscription = events.on(name, callback);
        disposers.push(() => subscription.off());
    };
    // Acquire Elements
    const dom = [
        'ui',
        'sceneLayer',
        'controlsWrap',
        'annotationNav',
        'arMode',
        'vrMode',
        'enterFullscreen',
        'exitFullscreen',
        'info',
        'infoPanel',
        'infoClose',
        'infoShortcuts',
        'rendererName',
        'gpuName',
        'engineVersionLabel',
        'buttonContainer',
        'play',
        'pause',
        'settings',
        'settingsPanel',
        'orbitCamera',
        'flyCamera',
        'fpsCamera',
        'performanceModeRow',
        'performanceModeCheck',
        'performanceModeOption',
        'gamingControlsRow',
        'gamingControlsCheck',
        'gamingControlsOption',
        'controlsButton',
        'controlsHint',
        'controlsHintClose',
        'reset',
        'frame',
        'loadingWrap',
        'loadingText',
        'loadingBar',
        'showCollisionRow',
        'showCollisionCheck',
        'showCollisionShortcut',
        'walkShortcut',
        'playShortcut',
        'tooltip',
        'viewerBranding',
        'appVersionLabel'
    ].reduce((acc, name) => {
        acc[name] = root.querySelector(`.sse-${name}`);
        return acc;
    }, {});
    // populate the info panel: versions, the renderer and the gpu it runs on
    dom.appVersionLabel.textContent = version;
    dom.engineVersionLabel.textContent = version$1;
    dom.rendererName.textContent = global.renderer === 'webgpu' ? 'WebGPU' : 'WebGL 2';
    dom.gpuName.textContent = getGpuName(global.app.graphicsDevice);
    // Remove focus from buttons after click so keyboard input isn't captured by the UI
    dom.ui.addEventListener('click', () => {
        document.activeElement?.blur();
    });
    // Forward wheel events from UI overlays to the canvas so the camera zooms
    // instead of the page scrolling (e.g. annotation nav, tooltips), and from the
    // scene layer beside the ui (the annotation hotspots), which the ui does not contain.
    // The non-standard wheelDelta{X,Y} properties aren't part of WheelEventInit,
    // so they get dropped by `new WheelEvent(type, init)`. We re-attach them so
    // the trackpad-vs-mouse classifier in input-controller.ts behaves the same
    // whether the event originated on the canvas or was forwarded from the UI.
    const canvas = global.app.graphicsDevice.canvas;
    const forwardWheel = (event) => {
        event.preventDefault();
        const forwarded = new WheelEvent(event.type, event);
        const src = event;
        for (const key of ['wheelDelta', 'wheelDeltaX', 'wheelDeltaY']) {
            if (typeof src[key] === 'number') {
                Object.defineProperty(forwarded, key, { value: src[key], configurable: true });
            }
        }
        canvas.dispatchEvent(forwarded);
    };
    // both are the canvas's siblings, so a forwarded event cannot bubble back into either
    for (const layer of [dom.ui, dom.sceneLayer]) {
        layer.addEventListener('wheel', forwardWheel, { passive: false });
    }
    // Handle loading progress updates
    const updateLoadingProgress = (progress) => {
        dom.loadingText.textContent = `${progress}%`;
        if (progress < 100) {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, #F60 0%, #F60 ${progress}%, white ${progress}%, white 100%)`;
        }
        else {
            dom.loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 100%)';
        }
    };
    on('progress:changed', updateLoadingProgress);
    updateLoadingProgress(state.progress);
    // Hide loading bar once loaded
    on('loaded:changed', () => {
        dom.loadingWrap.classList.add('sse-hidden');
    });
    // Performance mode toggle
    dom.performanceModeRow.addEventListener('click', () => {
        state.performanceMode = !state.performanceMode;
    });
    const updatePerformanceMode = () => {
        dom.performanceModeCheck.classList.toggle('sse-active', state.performanceMode);
    };
    on('performanceMode:changed', updatePerformanceMode);
    updatePerformanceMode();
    // Gaming mode toggle (settings row visible on mobile only)
    dom.gamingControlsRow.addEventListener('click', () => {
        state.gamingControls = !state.gamingControls;
    });
    const updateGamingSettingsVisibility = () => {
        const isDesktop = state.inputMode === 'desktop';
        dom.gamingControlsRow.classList.toggle('sse-hidden', isDesktop);
    };
    on('inputMode:changed', updateGamingSettingsVisibility);
    updateGamingSettingsVisibility();
    const updateGamingControls = () => {
        dom.gamingControlsCheck.classList.toggle('sse-active', state.gamingControls);
    };
    on('gamingControls:changed', updateGamingControls);
    updateGamingControls();
    // The settings, controls and info buttons are toggles: each shows active while its panel is
    // open. Every open and close goes through these so the two cannot disagree.
    const isVisible = (panel) => !panel.classList.contains('sse-hidden');
    // The controls panel and the settings panel share the space above the toolbar. The controls
    // panel's open state is the user's choice and persists: it stays open while the scene is used,
    // and shows once the scene has loaded. Settings is a quick look, so while it is open it only
    // stands in for the controls panel, which comes back when it closes.
    let controlsOpen = readOpen();
    const applyControls = () => {
        const visible = controlsOpen && state.loaded && !isVisible(dom.settingsPanel);
        dom.controlsHint.classList.toggle('sse-hidden', !visible);
        dom.controlsButton.classList.toggle('sse-active', visible);
    };
    const showSettings = (visible) => {
        dom.settingsPanel.classList.toggle('sse-hidden', !visible);
        dom.settings.classList.toggle('sse-active', visible);
        applyControls();
    };
    // the toolbar button toggles what it shows, so opening the panel from under settings
    // closes settings rather than leaving the panel open and unseen
    const showControls = (open) => {
        controlsOpen = open;
        writeOpen(open);
        if (open)
            showSettings(false);
        applyControls();
    };
    on('loaded:changed', applyControls);
    applyControls();
    // clicks rather than input events, so they restart the fade timer themselves
    const toggleControls = () => showControls(!isVisible(dom.controlsHint));
    dom.controlsButton.addEventListener('click', () => {
        toggleControls();
        showUI();
    });
    dom.controlsHintClose.addEventListener('click', () => {
        showControls(false);
        showUI();
    });
    const showInfo = (visible) => {
        // the shortcuts are keyboard shortcuts, and list only what this scene offers, as the
        // toolbar does: walk needs collision, play needs an animation
        dom.infoShortcuts.classList.toggle('sse-hidden', state.inputMode !== 'desktop');
        dom.walkShortcut.classList.toggle('sse-hidden', !state.walkAllowed);
        dom.playShortcut.classList.toggle('sse-hidden', !state.hasAnimation);
        dom.infoPanel.classList.toggle('sse-hidden', !visible);
        dom.info.classList.toggle('sse-active', visible);
    };
    // Info panel
    const toggleHelp = () => showInfo(!isVisible(dom.infoPanel));
    // these close a panel without an input event, so they restart the fade timer themselves
    dom.info.addEventListener('click', () => {
        toggleHelp();
        showUI();
    });
    // the panel covers the viewer, so this is also how a second click on the button closes it
    dom.infoPanel.addEventListener('pointerdown', () => {
        showInfo(false);
        showUI();
    });
    dom.infoClose.addEventListener('click', () => {
        showInfo(false);
        showUI();
    });
    on('inputEvent', (event) => {
        if (event === 'toggleHelp') {
            toggleHelp();
        }
        else if (event === 'toggleControls') {
            toggleControls();
        }
        else if (event === 'cancel') {
            // close info panel on cancel
            showInfo(false);
            showSettings(false);
        }
        else if (event === 'interrupt') {
            showSettings(false);
        }
    });
    // after 3 seconds of inactivity the controls dim, then hide 2.5 seconds later
    on('controlsHidden:changed', (value) => {
        dom.controlsWrap.classList.toggle('sse-faded-out', value);
        dom.controlsWrap.classList.toggle('sse-faded-in', !value);
    });
    // show the ui and start a timer to hide it again
    let uiTimeout = null;
    // the controls dim for a moment before hiding, both when idle and when the mouse is
    // captured, so they are seen to be going rather than vanishing at once
    let dimTimeout = null;
    // the pointer is over the controls: hold them up, and restart the timer on leaving
    let hovering = false;
    disposers.push(() => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
        if (dimTimeout) {
            clearTimeout(dimTimeout);
            dimTimeout = null;
        }
    });
    const isPointerCapturedMode = () => state.inputMode === 'desktop' &&
        state.gamingControls &&
        (state.cameraMode === 'walk' || state.cameraMode === 'fly');
    const setDimmed = (dimmed) => {
        dom.controlsWrap.classList.toggle('sse-dimmed', dimmed);
        dom.annotationNav.classList.toggle('sse-dimmed', dimmed);
    };
    const clearDim = () => {
        if (dimTimeout) {
            clearTimeout(dimTimeout);
            dimTimeout = null;
        }
        setDimmed(false);
    };
    const hideUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
        clearDim();
        hovering = false;
        showInfo(false);
        showSettings(false);
        state.controlsHidden = true;
    };
    // controlsHidden stays false while dimmed, so a host reading it sees dimmed controls as
    // shown; it turns true only once they are gone
    const dimThenHide = () => {
        clearDim();
        setDimmed(true);
        dimTimeout = setTimeout(hideUI, 2500);
    };
    // entering capture: the controls stay, dimmed, then hide
    const dimUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
        showInfo(false);
        showSettings(false);
        state.controlsHidden = false;
        dimThenHide();
    };
    const showUI = () => {
        if (isPointerCapturedMode()) {
            // input while captured (mouse look fires it constantly) does not bring the controls
            // back or cut the dim short; it only closes a panel a shortcut may have opened
            if (dimTimeout) {
                showInfo(false);
                showSettings(false);
            }
            else {
                hideUI();
            }
            return;
        }
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        clearDim();
        state.controlsHidden = false;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            // the controls stay while a panel is open or the pointer is over them; closing the
            // panel or leaving restarts this timer
            if (hovering || isVisible(dom.settingsPanel) || isVisible(dom.infoPanel) || isVisible(dom.controlsHint)) {
                return;
            }
            if (state.selectedAnnotation === null || !state.showAnnotations) {
                dimThenHide();
            }
        }, 3000);
    };
    // entering also restores dimmed controls to full
    dom.controlsWrap.addEventListener('pointerenter', () => {
        hovering = true;
        showUI();
    });
    dom.controlsWrap.addEventListener('pointerleave', () => {
        hovering = false;
        showUI();
    });
    // Show controls once loaded
    on('loaded:changed', () => {
        dom.controlsWrap.classList.remove('sse-hidden');
        showUI();
    });
    on('inputEvent', showUI);
    // dim on entering capture, show on leaving it; any other mode change just shows the controls
    let wasCaptured = false;
    const updateCapturedUI = () => {
        const captured = isPointerCapturedMode();
        if (captured && !wasCaptured) {
            dimUI();
        }
        else if (!captured) {
            clearDim();
            showUI();
        }
        wasCaptured = captured;
    };
    on('cameraMode:changed', updateCapturedUI);
    on('inputMode:changed', updateCapturedUI);
    on('gamingControls:changed', updateCapturedUI);
    // Keep controls visible while the selected annotation's panel is shown.
    on('selectedAnnotation:changed', showUI);
    disposers.push(initPlayback(viewer, root, showUI));
    disposers.push(initCameraControls(viewer, root));
    disposers.push(initControlsHint(viewer, root, localize));
    disposers.push(initFullscreenControls(viewer, root));
    disposers.push(initXrControls(viewer, root));
    // Collision overlay: a settings row and the matching info-panel shortcut, shown only when
    // the scene ships an overlay
    on('hasCollisionOverlay:changed', (value) => {
        dom.showCollisionRow.classList.toggle('sse-hidden', !value);
        dom.showCollisionShortcut.classList.toggle('sse-hidden', !value);
    });
    dom.showCollisionRow.addEventListener('click', () => {
        state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
    });
    on('collisionOverlayEnabled:changed', (value) => {
        dom.showCollisionCheck.classList.toggle('sse-active', value);
    });
    dom.settings.addEventListener('click', () => {
        showSettings(!isVisible(dom.settingsPanel));
        showUI();
    });
    // Initialize touch joystick for fly mode
    disposers.push(initJoystick(viewer, root));
    disposers.push(initAnnotationControls(viewer, root));
    if (viewer.annotations.length > 0) {
        const annotations = new Annotations(viewer, root, global.camera, getPicker, getCameraProgress);
        disposers.push(() => annotations.destroy());
    }
    // tooltips
    const tooltip = new Tooltip(dom.tooltip);
    disposers.push(tooltip.destroy);
    tooltip.register(dom.play, localize('tooltip.play'), 'top');
    tooltip.register(dom.pause, localize('tooltip.pause'), 'top');
    tooltip.register(dom.orbitCamera, localize('tooltip.orbit-camera'), 'top');
    tooltip.register(dom.flyCamera, localize('tooltip.fly-camera'), 'top');
    tooltip.register(dom.fpsCamera, localize('tooltip.walk-mode'), 'top');
    tooltip.register(dom.reset, localize('tooltip.reset-camera'), 'bottom');
    tooltip.register(dom.frame, localize('tooltip.frame-scene'), 'bottom');
    tooltip.register(dom.settings, localize('tooltip.settings'), 'top');
    tooltip.register(dom.info, localize('tooltip.help'), 'top');
    tooltip.register(dom.controlsButton, localize('tooltip.controls'), 'top');
    tooltip.register(dom.arMode, localize('tooltip.enter-ar'), 'top');
    tooltip.register(dom.vrMode, localize('tooltip.enter-vr'), 'top');
    tooltip.register(dom.enterFullscreen, localize('tooltip.fullscreen'), 'top');
    tooltip.register(dom.exitFullscreen, localize('tooltip.fullscreen'), 'top');
    const isThirdPartyEmbedded = () => {
        try {
            return window.location.hostname !== window.parent.location.hostname;
        }
        catch (_e) {
            // cross-origin iframe — parent location is inaccessible
            return true;
        }
    };
    if (window.parent !== window && isThirdPartyEmbedded()) {
        const viewUrl = new URL(window.location.href);
        if (viewUrl.pathname === '/s') {
            viewUrl.pathname = '/view';
        }
        dom.viewerBranding.href = viewUrl.toString();
        dom.viewerBranding.classList.remove('sse-hidden');
    }
    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
};

var uiHtml = "\n<canvas></canvas>\n\n<div class=\"sse-sceneLayer\"></div>\n\n<div class=\"sse-ui\">\n    <div class=\"sse-poster\"></div>\n\n    \n    <a class=\"sse-viewerBranding sse-hidden\" target=\"_blank\" rel=\"noopener noreferrer\">\n        <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"64 64 384 384\" role=\"img\" aria-label=\"SuperSplat\">\n            <path\n                fill=\"#F26722\"\n                d=\"M129.83,217c9.75,0,17.64-7.9,17.64-17.64s-7.9-17.64-17.64-17.64-17.64,7.9-17.64,17.64,7.9,17.64,17.64,17.64Z\"\n            />\n            <path\n                fill=\"#F26722\"\n                d=\"M388.74,253.94c-12.46,0-22.57,10.11-22.57,22.57s10.11,22.57,22.57,22.57,22.57-10.11,22.57-22.57-10.11-22.57-22.57-22.57h0Z\"\n            />\n            <path\n                fill=\"#F26722\"\n                d=\"M345.26,161.1h.02c.37-.05.65-.22.97-.33,16.78-2.32,29.75-16.57,29.75-33.99,0-19.04-15.43-34.46-34.46-34.46s-34.46,15.43-34.46,34.46c0,4.29.88,8.35,2.32,12.14.04.12-.01.25.04.38,10.55,29.18-22.33,23.62-39.07,20.74-.49-.09-.88-.07-1.32-.11-4.27-.56-8.59-.97-13.03-.97-53.93,0-97.64,43.71-97.64,97.64,0,9.84,1.48,19.32,4.2,28.28.04.1,0,.17.05.27,8.97,30.15-14.83,25.49-25.52,25.69-1.04-.13-2.09-.32-3.18-.32-13.51,0-24.45,10.94-24.45,24.45s10.94,24.45,24.45,24.45c11.69,0,21.44-8.22,23.85-19.19h.02c6.31-26.57,25.9-18.02,31.15-12.67.2.2.4.26.59.42,17.44,16.25,40.75,26.26,66.47,26.26.67,0,1.34-.09,2.01-.1.66.01,1.31.04,2.04.04,9.7-.04,17.82,10.91,4.94,29.68h.13c-4.42,6.01-7.1,13.36-7.1,21.41,0,20.09,16.29,36.39,36.39,36.39s36.39-16.29,36.39-36.39c0-15.4-9.61-28.49-23.12-33.81-.32-.15-.61-.29-.98-.45-12.28-4.94-25.43-17.69-6.89-27.1l-.04-.1c31.93-16.06,53.88-49.02,53.88-87.2,0-21.15-6.8-40.68-18.23-56.66-.13-.23-.23-.47-.44-.74-23.15-31.67-2.37-36.07,10.3-38.09h-.01Z\"\n            />\n            <path\n                fill=\"#fff\"\n                d=\"M230.79,284.71c0,7.95-6.44,14.38-14.38,14.38s-14.38-6.44-14.38-14.38v-22.95c0-7.95,6.44-14.38,14.38-14.38s14.38,6.44,14.38,14.38v22.95Z\"\n            />\n            <path\n                fill=\"#fff\"\n                d=\"M309.78,284.71c0,7.95-6.44,14.38-14.38,14.38s-14.38-6.44-14.38-14.38v-22.95c0-7.95,6.44-14.38,14.38-14.38s14.38,6.44,14.38,14.38v22.95Z\"\n            />\n        </svg>\n        <span>SuperSplat</span>\n    </a>\n\n    \n    <div class=\"sse-loadingWrap\">\n        <div class=\"sse-loadingText\"></div>\n        <div class=\"sse-loadingBar\"></div>\n    </div>\n\n    <div class=\"sse-controlsWrap sse-hidden\">\n        \n        <div class=\"sse-timelineContainer sse-hidden\">\n            <div class=\"sse-line\"></div>\n            <div class=\"sse-handle\"></div>\n            <div class=\"sse-time sse-hidden\">0:00</div>\n        </div>\n\n        \n        <div class=\"sse-buttonsContainer\">\n            <div class=\"sse-buttonGroup\">\n                <button class=\"sse-play sse-controlButton sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#playIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#playIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-pause sse-controlButton sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24px\" height=\"24px\">\n                        <g class=\"sse-stroke\"><use href=\"#pauseIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#pauseIcon\" /></g>\n                    </svg>\n                </button>\n            </div>\n\n            <div class=\"sse-spacer\"></div>\n\n            <div class=\"sse-buttonGroup\">\n                <button class=\"sse-orbitCamera sse-controlButton sse-toggle sse-left\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#orbitIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#orbitIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-flyCamera sse-controlButton sse-toggle sse-right\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#flyIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#flyIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-fpsCamera sse-controlButton sse-toggle sse-right sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#walkIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#walkIcon\" /></g>\n                    </svg>\n                </button>\n            </div>\n\n            <div class=\"sse-buttonGroup\">\n                \n                <button class=\"sse-settings sse-controlButton\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#settingsIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#settingsIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-controlsButton sse-controlButton\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#keyboardIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#keyboardIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-info sse-controlButton\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#infoIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#infoIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-arMode sse-controlButton sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#arIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#arIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-vrMode sse-controlButton sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#vrIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#vrIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-enterFullscreen sse-controlButton\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#enterFullscreenIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#enterFullscreenIcon\" /></g>\n                    </svg>\n                </button>\n                <button class=\"sse-exitFullscreen sse-controlButton sse-hidden\">\n                    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\">\n                        <g class=\"sse-stroke\"><use href=\"#exitFullscreenIcon\" /></g>\n                        <g class=\"sse-fill\"><use href=\"#exitFullscreenIcon\" /></g>\n                    </svg>\n                </button>\n            </div>\n        </div>\n    </div>\n\n    \n    <div class=\"sse-joystickBase sse-hidden\">\n        <div class=\"sse-joystick\"></div>\n    </div>\n\n    \n    <div class=\"sse-annotationNav sse-hidden\">\n        <button class=\"sse-annotationPrev\">\n            <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\">\n                <g class=\"sse-stroke\"><use href=\"#chevronLeftIcon\" /></g>\n                <g class=\"sse-fill\"><use href=\"#chevronLeftIcon\" /></g>\n            </svg>\n        </button>\n        <div class=\"sse-annotationInfo\">\n            <span class=\"sse-annotationNavNumber\"></span>\n            <span class=\"sse-annotationNavTitle\"></span>\n        </div>\n        <button class=\"sse-annotationNext\">\n            <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\">\n                <g class=\"sse-stroke\"><use href=\"#chevronRightIcon\" /></g>\n                <g class=\"sse-fill\"><use href=\"#chevronRightIcon\" /></g>\n            </svg>\n        </button>\n    </div>\n\n    \n    <div class=\"sse-controlsHint sse-hidden\">\n        <div class=\"sse-controlsHintHeader\">\n            <svg class=\"sse-controlsHintIcon\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">\n                <use href=\"#orbitIcon\" />\n            </svg>\n            <div class=\"sse-controlsHintTitles\">\n                <span class=\"sse-controlsHintTitle\"></span>\n                <span class=\"sse-controlsHintSubtitle\"></span>\n            </div>\n            <button class=\"sse-controlsHintClose sse-panelButton\">\n                <svg xmlns=\"http://www.w3.org/2000/svg\"><use href=\"#closeIcon\" /></svg>\n            </button>\n        </div>\n        <div class=\"sse-controlsHintRows\"></div>\n    </div>\n\n    \n    <div class=\"sse-settingsPanel sse-hidden\">\n        \n        <div class=\"sse-settingsGroup\">\n            <div class=\"sse-annotationsRow sse-settingsRow\">\n                <div class=\"sse-annotationsOption\" data-i18n=\"settings.show-annotations\">Show Annotations</div>\n                <div class=\"sse-annotationsCheck sse-toggleSwitch sse-active\">\n                    <div class=\"sse-toggleTrack\"><div class=\"sse-toggleThumb\"></div></div>\n                </div>\n            </div>\n            <div class=\"sse-showCollisionRow sse-settingsRow sse-hidden\">\n                <div class=\"sse-showCollisionOption\" data-i18n=\"settings.show-collision\">Show Collision</div>\n                <div class=\"sse-showCollisionCheck sse-toggleSwitch\">\n                    <div class=\"sse-toggleTrack\"><div class=\"sse-toggleThumb\"></div></div>\n                </div>\n            </div>\n        </div>\n        \n        <div class=\"sse-settingsGroup\">\n            <div class=\"sse-gamingControlsRow sse-settingsRow\">\n                <div class=\"sse-gamingControlsOption\" data-i18n=\"settings.gaming-controls\">Gaming Controls</div>\n                <div class=\"sse-gamingControlsCheck sse-toggleSwitch\">\n                    <div class=\"sse-toggleTrack\"><div class=\"sse-toggleThumb\"></div></div>\n                </div>\n            </div>\n            <div class=\"sse-performanceModeRow sse-settingsRow\">\n                <div class=\"sse-performanceModeOption\" data-i18n=\"settings.performance-mode\">Performance Mode</div>\n                <div class=\"sse-performanceModeCheck sse-toggleSwitch\">\n                    <div class=\"sse-toggleTrack\"><div class=\"sse-toggleThumb\"></div></div>\n                </div>\n            </div>\n        </div>\n        \n        <div class=\"sse-settingsGroup\">\n            <div class=\"sse-settingsRow\">\n                <button class=\"sse-frame\" data-i18n=\"settings.frame\">Frame</button>\n                <button class=\"sse-reset\" data-i18n=\"settings.reset\">Reset</button>\n            </div>\n        </div>\n    </div>\n\n    \n    <div class=\"sse-tooltip\"></div>\n\n    \n    <div class=\"sse-infoPanel sse-hidden\">\n        <div class=\"sse-infoPanelContent\" onpointerdown=\"event.stopPropagation()\" onwheel=\"event.stopPropagation()\">\n            <button class=\"sse-infoClose sse-panelButton\">\n                <svg xmlns=\"http://www.w3.org/2000/svg\"><use href=\"#closeIcon\" /></svg>\n            </button>\n            <a\n                class=\"sse-viewerTitle\"\n                href=\"https://github.com/playcanvas/supersplat-viewer\"\n                target=\"_blank\"\n                rel=\"noopener noreferrer\"\n            >\n                <svg class=\"sse-viewerLogo\" xmlns=\"http://www.w3.org/2000/svg\" aria-hidden=\"true\">\n                    <use href=\"#supersplatIcon\" />\n                </svg>\n                <span class=\"sse-title-name\">SuperSplat Viewer</span>\n                <span class=\"sse-title-version\">v<span class=\"sse-appVersionLabel\"></span></span>\n            </a>\n            <div class=\"sse-infoGpu\">\n                <span class=\"sse-rendererName\"></span>\n                <span class=\"sse-gpuName\"></span>\n            </div>\n            <div class=\"sse-infoLinks\">\n                <a\n                    class=\"sse-infoLink\"\n                    href=\"https://github.com/playcanvas/engine\"\n                    target=\"_blank\"\n                    rel=\"noopener noreferrer\"\n                >\n                    <span>PlayCanvas Engine</span>\n                    <span class=\"sse-infoLinkVersion\">v<span class=\"sse-engineVersionLabel\"></span></span>\n                </a>\n            </div>\n            <div class=\"sse-infoShortcuts\">\n                <h1 data-i18n=\"help.section.modes\">Mode Switching</h1>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.orbit-mode\">Orbit Mode</span>\n                    <kbd class=\"sse-key\">1</kbd>\n                </div>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.fly-mode\">Fly Mode</span>\n                    <kbd class=\"sse-key\">2</kbd>\n                </div>\n                <div class=\"sse-walkShortcut sse-infoShortcut\">\n                    <span data-i18n=\"help.action.toggle-walk\">Toggle Walk</span>\n                    <kbd class=\"sse-key\">3</kbd>\n                </div>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.toggle-gaming\">Toggle Gaming Controls</span>\n                    <kbd class=\"sse-key\">G</kbd>\n                </div>\n                <div class=\"sse-showCollisionShortcut sse-infoShortcut sse-hidden\">\n                    <span data-i18n=\"help.action.show-collision\">Show Collision</span>\n                    <kbd class=\"sse-key\">V</kbd>\n                </div>\n                <div class=\"sse-playShortcut sse-infoShortcut\">\n                    <span data-i18n=\"help.action.play-pause\">Play / Pause</span>\n                    <kbd class=\"sse-key\" data-i18n=\"help.key.space\">Space</kbd>\n                </div>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.toggle-controls\">Toggle Controls</span>\n                    <kbd class=\"sse-key\">H</kbd>\n                </div>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.toggle-help\">Toggle Info</span>\n                    <span class=\"sse-keys\"><kbd class=\"sse-key\">Shift</kbd><kbd class=\"sse-key\">H</kbd></span>\n                </div>\n                <div class=\"sse-infoShortcut\">\n                    <span data-i18n=\"help.action.exit-cancel\">Exit / Cancel</span>\n                    <kbd class=\"sse-key\" data-i18n=\"help.key.esc\">Esc</kbd>\n                </div>\n            </div>\n        </div>\n    </div>\n\n    \n    <div class=\"sse-xrModal sse-hidden\" onwheel=\"event.stopPropagation()\">\n        <div class=\"sse-xrModalContent\" onpointerdown=\"event.stopPropagation()\">\n            <h2 data-i18n=\"xr-modal.title\">WebGL Required</h2>\n            <p data-i18n=\"xr-modal.message\">\n                AR and VR are not supported on the WebGPU renderer. Pressing OK will reload the viewer with WebGL.\n            </p>\n            <div class=\"sse-xrModalButtons\">\n                <button class=\"sse-xrModalCancel\" data-i18n=\"xr-modal.cancel\">Cancel</button>\n                <button class=\"sse-xrModalOk\" data-i18n=\"xr-modal.ok\">OK</button>\n            </div>\n        </div>\n    </div>\n</div>\n\n<svg>\n    <symbol id=\"playIcon\" viewBox=\"-2 0 24 24\">\n        <path\n            d=\"M1 1.98725C1 1.20022 1.87789 0.730421 2.5332 1.16694L14.5605 9.18061C15.146 9.57066 15.146 10.4302 14.5605 10.8203L2.5332 18.833C1.87788 19.2695 1 18.7997 1 18.0126V1.98725Z\"\n            transform=\"translate(2 2)\"\n        />\n    </symbol>\n    <symbol id=\"pauseIcon\" viewBox=\"0 0 20 20\">\n        <path d=\"M5 16V4h3v12H5zm7-12h3v12h-3V4z\" />\n    </symbol>\n    <symbol id=\"orbitIcon\" viewBox=\"-2 -2 20 20\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M4.44728 1.7561C6.14077 0.763957 8.53159 1.57857 10.4375 3.58357C12.75 3.02099 14.4585 3.40647 14.6491 4.73071C14.7831 5.66256 14.139 6.87994 12.9942 8.09008C13.7427 10.7586 13.2413 13.2551 11.5527 14.2444C9.85867 15.2369 7.46679 14.4208 5.56056 12.4143C3.34914 12.9521 1.691 12.6254 1.38412 11.4371L1.35092 11.2698C1.21678 10.3379 1.85972 9.11931 3.00457 7.90909C2.28693 5.34963 2.72037 2.94871 4.24741 1.88435L4.44728 1.7561ZM11.9889 9.03995C11.002 9.88136 9.79998 10.6808 8.47918 11.3303L8.13673 11.4937C7.70533 11.6942 7.28148 11.8681 6.8698 12.0172C7.32387 12.4287 7.79226 12.7587 8.25326 12.9983C9.39237 13.5903 10.3231 13.574 10.946 13.2092C11.5745 12.841 12.0613 12.0184 12.1263 10.7086C12.1518 10.1934 12.1065 9.62999 11.9889 9.03995ZM3.46225 9.20206C3.15128 9.5802 2.91825 9.93412 2.76238 10.2489C2.54363 10.6909 2.51958 10.967 2.53842 11.0985C2.54902 11.1721 2.56635 11.2146 2.67058 11.2763C2.81832 11.3636 3.12484 11.4626 3.6478 11.467C3.95641 11.4696 4.3074 11.4373 4.69402 11.3707C4.45655 11.0439 4.23084 10.6971 4.02215 10.3303C3.81017 9.95774 3.62416 9.58004 3.46225 9.20206ZM10.0358 4.9423C9.42018 5.13611 8.75205 5.40184 8.05014 5.74698C6.61265 6.45384 5.33887 7.34291 4.37175 8.24373C4.55213 8.73829 4.78227 9.2401 5.06511 9.73722C5.33995 10.2202 5.64271 10.6614 5.96355 11.0575C6.5793 10.8637 7.24782 10.5987 7.94988 10.2535C9.38732 9.54667 10.6605 8.65688 11.6276 7.7561C11.4473 7.26173 11.2176 6.76019 10.9349 6.26326C10.66 5.78001 10.3568 5.33855 10.0358 4.9423ZM7.74675 3.00219C6.60759 2.41015 5.67698 2.42644 5.05405 2.79126C4.42548 3.15953 3.93866 3.98199 3.87371 5.29191C3.84822 5.80668 3.89236 6.36967 4.00978 6.95922C4.91091 6.19088 5.9923 5.45862 7.17905 4.84269L7.52084 4.67016C8.07056 4.39986 8.6096 4.17089 9.12957 3.98266C8.67568 3.57138 8.20757 3.24172 7.74675 3.00219ZM12.3522 4.53344C12.0433 4.53086 11.6918 4.56177 11.3047 4.6285C11.5425 4.95566 11.7689 5.3029 11.9779 5.67016C12.1897 6.04255 12.3753 6.41999 12.5371 6.79777C12.8481 6.41965 13.0818 6.06635 13.2376 5.75154C13.4564 5.30973 13.4804 5.03352 13.4616 4.90193C13.451 4.82831 13.4337 4.7859 13.3294 4.7242C13.1817 4.63684 12.8753 4.53787 12.3522 4.53344Z\"\n        />\n    </symbol>\n    <symbol id=\"flyIcon\" viewBox=\"-2 -2 20 20\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M12 1.33337C13.4727 1.33337 14.6666 2.52728 14.6666 4.00004C14.6666 5.4728 13.4727 6.66671 12 6.66671C11.4931 6.66671 11.0194 6.52491 10.6159 6.27934L10.2721 6.62374C10.0345 6.86142 9.90102 7.18411 9.90102 7.52022V8.47986C9.90102 8.81597 10.0345 9.13866 10.2721 9.37634L10.6159 9.72009C11.0193 9.47463 11.4932 9.33337 12 9.33337C13.4727 9.33337 14.6666 10.5273 14.6666 12C14.6666 13.4728 13.4727 14.6667 12 14.6667C10.5272 14.6667 9.33331 13.4728 9.33331 12C9.33331 11.4932 9.47457 11.0194 9.72003 10.6159L9.37628 10.2722C9.1386 10.0345 8.81591 9.90108 8.4798 9.90108H7.52016C7.18405 9.90108 6.86136 10.0345 6.62368 10.2722L6.27928 10.6159C6.52485 11.0195 6.66665 11.4931 6.66665 12C6.66665 13.4728 5.47274 14.6667 3.99998 14.6667C2.52722 14.6667 1.33331 13.4728 1.33331 12C1.33331 10.5273 2.52722 9.33337 3.99998 9.33337C4.50658 9.33337 4.98008 9.47481 5.38344 9.72009L5.72784 9.37634C5.9655 9.13866 6.09894 8.81597 6.09894 8.47986V7.52022C6.09894 7.18411 5.9655 6.86142 5.72784 6.62374L5.38344 6.27934C4.98001 6.52473 4.5067 6.66671 3.99998 6.66671C2.52722 6.66671 1.33331 5.4728 1.33331 4.00004C1.33331 2.52728 2.52722 1.33337 3.99998 1.33337C5.47274 1.33337 6.66665 2.52728 6.66665 4.00004C6.66665 4.50676 6.52467 4.98008 6.27928 5.3835L6.62368 5.72791C6.86136 5.96556 7.18405 6.099 7.52016 6.099H8.4798C8.81591 6.099 9.1386 5.96556 9.37628 5.72791L9.72003 5.3835C9.47475 4.98014 9.33331 4.50664 9.33331 4.00004C9.33331 2.52728 10.5272 1.33337 12 1.33337ZM3.99998 10.3998C3.11632 10.3998 2.39972 11.1164 2.39972 12C2.39972 12.8837 3.11632 13.6003 3.99998 13.6003C4.88364 13.6003 5.60024 12.8837 5.60024 12C5.60024 11.7911 5.55917 11.5919 5.48631 11.4089L4.41469 12.4812C4.16723 12.7284 3.76625 12.7286 3.51886 12.4812C3.27147 12.2338 3.27158 11.8328 3.51886 11.5853L4.59047 10.5131C4.40769 10.4404 4.20862 10.3998 3.99998 10.3998ZM12 10.3998C11.7911 10.3998 11.5918 10.4403 11.4088 10.5131L12.4811 11.5853C12.7284 11.8328 12.7285 12.2338 12.4811 12.4812C12.2337 12.7286 11.8327 12.7284 11.5853 12.4812L10.513 11.4089C10.4402 11.5918 10.3997 11.7912 10.3997 12C10.3997 12.8837 11.1163 13.6003 12 13.6003C12.8836 13.6003 13.6002 12.8837 13.6002 12C13.6002 11.1164 12.8836 10.3998 12 10.3998ZM3.99998 2.39978C3.11632 2.39978 2.39972 3.11639 2.39972 4.00004C2.39972 4.8837 3.11632 5.6003 3.99998 5.6003C4.20871 5.6003 4.40763 5.55909 4.59047 5.48637L3.51886 4.41475C3.27158 4.16729 3.27147 3.76631 3.51886 3.51892C3.76625 3.27153 4.16723 3.27164 4.41469 3.51892L5.48631 4.59054C5.55903 4.40769 5.60024 4.20877 5.60024 4.00004C5.60024 3.11639 4.88364 2.39978 3.99998 2.39978ZM12 2.39978C11.1163 2.39978 10.3997 3.11639 10.3997 4.00004C10.3997 4.20868 10.4403 4.40775 10.513 4.59054L11.5853 3.51892C11.8327 3.27164 12.2337 3.27153 12.4811 3.51892C12.7285 3.76631 12.7284 4.16729 12.4811 4.41475L11.4088 5.48637C11.5918 5.55923 11.791 5.6003 12 5.6003C12.8836 5.6003 13.6002 4.8837 13.6002 4.00004C13.6002 3.11639 12.8836 2.39978 12 2.39978Z\"\n        />\n    </symbol>\n    <symbol id=\"walkIcon\" viewBox=\"-2 -2 20 20\">\n        <path d=\"M9.75 2a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0zM5.25 4.75h5.5v4.5h-.5v5h-2v-5h-.5v5h-2v-5h-.5z\" />\n    </symbol>\n    <symbol id=\"arIcon\" viewBox=\"0 0 24 24\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M12 15.3994V6H16.9629C18.2109 6 19.1167 6.1089 19.6797 6.32715C20.248 6.53997 20.7021 6.92247 21.042 7.47363C21.3818 8.02476 21.5518 8.65491 21.5518 9.36426C21.5518 10.2645 21.2943 11.0093 20.7793 11.5986C20.2641 12.1825 19.4938 12.5513 18.4688 12.7041C18.9786 13.0097 19.3983 13.3453 19.7275 13.7109C20.0621 14.0766 20.5113 14.7261 21.0742 15.6592L22.5 18H19.6797L17.9746 15.3887C17.3694 14.4559 16.9555 13.8691 16.7324 13.6289C16.5095 13.3835 16.2729 13.2172 16.0234 13.1299C15.7738 13.0371 15.3777 12.9902 14.8359 12.9902H14.3584V18H10.4053L9.35742 15.2744H4.56055L3.57031 18H1L5.67383 6H8.23633L12 15.3994ZM5.30566 13.252H8.58008L6.92676 8.7998L5.30566 13.252ZM14.3584 11.0752H16.1025C17.2336 11.0752 17.9401 11.0259 18.2217 10.9277C18.5032 10.8295 18.7235 10.66 18.8828 10.4199C19.0421 10.1798 19.1221 9.87966 19.1221 9.51953C19.122 9.11597 19.016 8.79138 18.8037 8.5459C18.5966 8.29488 18.3013 8.13677 17.9189 8.07129C17.7276 8.04401 17.1541 8.03027 16.1982 8.03027H14.3584V11.0752Z\"\n        />\n    </symbol>\n    <symbol id=\"vrIcon\" viewBox=\"0 0 24 24\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M5.52148 10.7021L7.15918 15.1133L8.76465 10.7021L9.50195 8.7002L10.4834 6H16.9541C18.1903 6 19.0879 6.10801 19.6455 6.32422C20.2081 6.53499 20.6576 6.9134 20.9941 7.45898C21.3308 8.00484 21.499 8.62946 21.499 9.33203C21.499 10.2239 21.2446 10.9622 20.7344 11.5459C20.2241 12.1242 19.4606 12.4893 18.4453 12.6406C18.9503 12.9433 19.3662 13.2756 19.6924 13.6377C20.0238 13.9999 20.4688 14.6432 21.0264 15.5674L22.4385 17.8857H19.6455L17.9561 15.2998C17.3565 14.3758 16.9466 13.7946 16.7256 13.5566C16.5047 13.3135 16.2706 13.148 16.0234 13.0615C15.7762 12.9696 15.3841 12.9238 14.8477 12.9238H14.374V17.8857H12.0381V8.54395L8.39941 17.8857H5.86133L1.10254 6H3.71289L5.52148 10.7021ZM14.374 11.0264H16.1025C17.2228 11.0264 17.9224 10.9781 18.2012 10.8809C18.4799 10.7836 17.6986 10.6157 18.8564 10.3779C19.0141 10.1402 19.0928 9.84288 19.0928 9.48633C19.0928 9.08641 18.9877 8.7647 18.7773 8.52148C18.5722 8.27286 18.2801 8.11565 17.9014 8.05078C17.712 8.02376 17.1439 8.01075 16.1973 8.01074H14.374V11.0264Z\"\n        />\n    </symbol>\n    <symbol id=\"infoIcon\" viewBox=\"-2 -2 24 24\">\n        <path\n            d=\"M9.98633 7.58301C10.2598 7.58301 10.4854 7.67643 10.6631 7.86328C10.8408 8.05013 10.9297 8.3099 10.9297 8.64258V14.0361C10.9297 14.4098 10.8408 14.6924 10.6631 14.8838C10.4854 15.0752 10.2598 15.1709 9.98633 15.1709C9.71289 15.1709 9.48958 15.0729 9.31641 14.877C9.14779 14.681 9.06348 14.4007 9.06348 14.0361V8.69727C9.06348 8.32812 9.14779 8.05013 9.31641 7.86328C9.48958 7.67643 9.71289 7.58301 9.98633 7.58301Z\"\n        />\n        <path\n            d=\"M10.0068 4.88965C10.2484 4.88965 10.4626 4.96712 10.6494 5.12207C10.8363 5.27702 10.9297 5.5026 10.9297 5.79883C10.9297 6.08594 10.8385 6.31152 10.6562 6.47559C10.474 6.63509 10.2575 6.71484 10.0068 6.71484C9.74707 6.71484 9.52376 6.63509 9.33691 6.47559C9.15462 6.31608 9.06348 6.09049 9.06348 5.79883C9.06348 5.53451 9.1569 5.31803 9.34375 5.14941C9.53516 4.97624 9.75618 4.88965 10.0068 4.88965Z\"\n        />\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M10 0C15.5228 0 20 4.47715 20 10C20 15.5228 15.5228 20 10 20C4.47715 20 0 15.5228 0 10C0 4.47715 4.47715 0 10 0ZM10 1.7998C5.47126 1.7998 1.7998 5.47126 1.7998 10C1.7998 14.5287 5.47126 18.2002 10 18.2002C14.5287 18.2002 18.2002 14.5287 18.2002 10C18.2002 5.47126 14.5287 1.7998 10 1.7998Z\"\n        />\n    </symbol>\n    <symbol id=\"settingsIcon\" viewBox=\"0 0 24 24\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M12 8C14.2091 8 16 9.79086 16 12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12C8 9.79086 9.79086 8 12 8ZM12 9.7998C10.785 9.7998 9.7998 10.785 9.7998 12C9.7998 13.215 10.785 14.2002 12 14.2002C13.215 14.2002 14.2002 13.215 14.2002 12C14.2002 10.785 13.215 9.7998 12 9.7998Z\"\n        />\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M12.7119 2.2002C13.1961 2.20028 13.6296 2.49055 13.8164 2.93066L13.8506 3.02051L14.3652 4.56641C14.7875 4.70091 15.1932 4.87075 15.5801 5.07129L17.042 4.3418L17.1299 4.30176C17.5436 4.13502 18.017 4.21245 18.3564 4.50195L18.4268 4.56641L19.4336 5.57324C19.7985 5.93836 19.8889 6.49621 19.6582 6.95801L18.9268 8.41895C19.1274 8.80592 19.2971 9.21159 19.4316 9.63379L20.9795 10.1504C21.4693 10.3138 21.7997 10.7717 21.7998 11.2881V12.7119C21.7997 13.2284 21.4695 13.6873 20.9795 13.8506L19.4316 14.3652C19.2971 14.7875 19.1274 15.1932 18.9268 15.5801L19.6582 17.042C19.8889 17.5038 19.7985 18.0616 19.4336 18.4268L18.4268 19.4336C18.0616 19.7985 17.5038 19.8889 17.042 19.6582L15.5801 18.9268C15.1932 19.1274 14.7875 19.2971 14.3652 19.4316L13.8506 20.9795C13.6873 21.4695 13.2284 21.7997 12.7119 21.7998H11.2881C10.7717 21.7997 10.3138 21.4693 10.1504 20.9795L9.63379 19.4316C9.21159 19.2971 8.80592 19.1274 8.41895 18.9268L6.95801 19.6582C6.49621 19.8889 5.93836 19.7985 5.57324 19.4336L4.56641 18.4268C4.20146 18.0617 4.1112 17.5038 4.3418 17.042L5.07129 15.5801C4.87075 15.1932 4.70091 14.7875 4.56641 14.3652L3.02051 13.8506C2.53057 13.6873 2.20029 13.2283 2.2002 12.7119V11.2881C2.20024 10.7718 2.53076 10.3139 3.02051 10.1504L4.56641 9.63379C4.70094 9.21149 4.86966 8.80498 5.07031 8.41797L4.3418 6.95801C4.11113 6.49617 4.20145 5.93834 4.56641 5.57324L5.57324 4.56641C5.93834 4.20145 6.49617 4.11113 6.95801 4.3418L8.41797 5.07031C8.80498 4.86966 9.21149 4.70094 9.63379 4.56641L10.1504 3.02051L10.1836 2.92969C10.3706 2.49001 10.8042 2.20023 11.2881 2.2002H12.7119ZM11.0186 5.4707L10.8809 5.88477L10.458 5.99316C9.88479 6.13982 9.34317 6.36768 8.84473 6.66309L8.46875 6.88477L8.0791 6.69043L6.50098 5.90137L5.90137 6.50098L6.69043 8.0791L6.88477 8.46875L6.66309 8.84473C6.36768 9.34317 6.13982 9.88479 5.99316 10.458L5.88477 10.8809L5.4707 11.0186L3.7998 11.5762V12.4229L5.4707 12.9805L5.88477 13.1182L5.99316 13.541C6.13969 14.1141 6.36763 14.6556 6.66309 15.1543L6.88477 15.5303L6.69043 15.9199L5.90137 17.498L6.50098 18.0977L8.0791 17.3086L8.46875 17.1133L8.84473 17.3359C9.34314 17.6314 9.88463 17.8591 10.458 18.0059L10.8809 18.1143L11.0186 18.5283L11.5771 20.2002H12.4229L13.1182 18.1143L13.541 18.0059C14.1143 17.8593 14.6556 17.6314 15.1543 17.3359L15.5303 17.1143L15.9199 17.3086L17.498 18.0977L18.0977 17.498L17.3086 15.9199L17.1143 15.5303L17.3359 15.1543C17.6314 14.6556 17.8593 14.1143 18.0059 13.541L18.1143 13.1182L20.2002 12.4229V11.5762L18.1143 10.8809L18.0059 10.458C17.8591 9.88463 17.6314 9.34314 17.3359 8.84473L17.1133 8.46875L17.3086 8.0791L18.0977 6.50098L17.498 5.90137L15.9199 6.69043L15.5303 6.88477L15.1543 6.66309C14.6556 6.36763 14.1141 6.13969 13.541 5.99316L13.1182 5.88477L12.9805 5.4707L12.4229 3.7998H11.5762L11.0186 5.4707Z\"\n        />\n    </symbol>\n    <symbol id=\"enterFullscreenIcon\" viewBox=\"0 0 24 24\">\n        <path\n            d=\"M3 14.7002C3.49693 14.7002 3.90018 15.1027 3.90039 15.5996V20C3.90039 20.0552 3.94477 20.0996 4 20.0996H8.40039C8.89727 20.0998 9.2998 20.5031 9.2998 21C9.2998 21.4969 8.89727 21.9002 8.40039 21.9004H4C2.95066 21.9004 2.09961 21.0493 2.09961 20V15.5996C2.09982 15.1027 2.50307 14.7002 3 14.7002Z\"\n        />\n        <path\n            d=\"M21 14.7002C21.4969 14.7002 21.9002 15.1027 21.9004 15.5996V20C21.9004 21.0493 21.0493 21.9004 20 21.9004H15.5996C15.1027 21.9002 14.7002 21.4969 14.7002 21C14.7002 20.5031 15.1027 20.0998 15.5996 20.0996H20C20.0552 20.0996 20.0996 20.0552 20.0996 20V15.5996C20.0998 15.1027 20.5031 14.7002 21 14.7002Z\"\n        />\n        <path\n            d=\"M8.40039 2.09961C8.89727 2.09982 9.2998 2.50307 9.2998 3C9.2998 3.49693 8.89727 3.90018 8.40039 3.90039H4C3.94477 3.90039 3.90039 3.94477 3.90039 4V8.40039C3.90018 8.89727 3.49693 9.2998 3 9.2998C2.50307 9.2998 2.09982 8.89727 2.09961 8.40039V4C2.09961 2.95066 2.95066 2.09961 4 2.09961H8.40039Z\"\n        />\n        <path\n            d=\"M20 2.09961C21.0493 2.09961 21.9004 2.95066 21.9004 4V8.40039C21.9002 8.89727 21.4969 9.2998 21 9.2998C20.5031 9.2998 20.0998 8.89727 20.0996 8.40039V4C20.0996 3.94477 20.0552 3.90039 20 3.90039H15.5996C15.1027 3.90018 14.7002 3.49693 14.7002 3C14.7002 2.50307 15.1027 2.09982 15.5996 2.09961H20Z\"\n        />\n    </symbol>\n    <symbol id=\"supersplatIcon\" viewBox=\"64 64 384 384\">\n        <path\n            fill=\"#F26722\"\n            d=\"M129.83,217c9.75,0,17.64-7.9,17.64-17.64s-7.9-17.64-17.64-17.64-17.64,7.9-17.64,17.64,7.9,17.64,17.64,17.64Z\"\n        />\n        <path\n            fill=\"#F26722\"\n            d=\"M388.74,253.94c-12.46,0-22.57,10.11-22.57,22.57s10.11,22.57,22.57,22.57,22.57-10.11,22.57-22.57-10.11-22.57-22.57-22.57h0Z\"\n        />\n        <path\n            fill=\"#F26722\"\n            d=\"M345.26,161.1h.02c.37-.05.65-.22.97-.33,16.78-2.32,29.75-16.57,29.75-33.99,0-19.04-15.43-34.46-34.46-34.46s-34.46,15.43-34.46,34.46c0,4.29.88,8.35,2.32,12.14.04.12-.01.25.04.38,10.55,29.18-22.33,23.62-39.07,20.74-.49-.09-.88-.07-1.32-.11-4.27-.56-8.59-.97-13.03-.97-53.93,0-97.64,43.71-97.64,97.64,0,9.84,1.48,19.32,4.2,28.28.04.1,0,.17.05.27,8.97,30.15-14.83,25.49-25.52,25.69-1.04-.13-2.09-.32-3.18-.32-13.51,0-24.45,10.94-24.45,24.45s10.94,24.45,24.45,24.45c11.69,0,21.44-8.22,23.85-19.19h.02c6.31-26.57,25.9-18.02,31.15-12.67.2.2.4.26.59.42,17.44,16.25,40.75,26.26,66.47,26.26.67,0,1.34-.09,2.01-.1.66.01,1.31.04,2.04.04,9.7-.04,17.82,10.91,4.94,29.68h.13c-4.42,6.01-7.1,13.36-7.1,21.41,0,20.09,16.29,36.39,36.39,36.39s36.39-16.29,36.39-36.39c0-15.4-9.61-28.49-23.12-33.81-.32-.15-.61-.29-.98-.45-12.28-4.94-25.43-17.69-6.89-27.1l-.04-.1c31.93-16.06,53.88-49.02,53.88-87.2,0-21.15-6.8-40.68-18.23-56.66-.13-.23-.23-.47-.44-.74-23.15-31.67-2.37-36.07,10.3-38.09h-.01Z\"\n        />\n        <path\n            fill=\"#fff\"\n            d=\"M230.79,284.71c0,7.95-6.44,14.38-14.38,14.38s-14.38-6.44-14.38-14.38v-22.95c0-7.95,6.44-14.38,14.38-14.38s14.38,6.44,14.38,14.38v22.95Z\"\n        />\n        <path\n            fill=\"#fff\"\n            d=\"M309.78,284.71c0,7.95-6.44,14.38-14.38,14.38s-14.38-6.44-14.38-14.38v-22.95c0-7.95,6.44-14.38,14.38-14.38s14.38,6.44,14.38,14.38v22.95Z\"\n        />\n    </symbol>\n    <symbol id=\"keyboardIcon\" viewBox=\"0 0 24 24\">\n        <path\n            fill-rule=\"evenodd\"\n            clip-rule=\"evenodd\"\n            d=\"M4 5.5h16a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 16V8A2.5 2.5 0 0 1 4 5.5Zm0 1.8a.7.7 0 0 0-.7.7v8c0 .39.31.7.7.7h16a.7.7 0 0 0 .7-.7V8a.7.7 0 0 0-.7-.7H4Z\"\n        />\n        <path d=\"M5 9h2v2H5zM8.5 9h2v2h-2zM12 9h2v2h-2zM15.5 9h2v2h-2zM7 13h10v2H7z\" />\n    </symbol>\n    <symbol id=\"closeIcon\" viewBox=\"0 0 24 24\">\n        <path d=\"M6 6l12 12M18 6L6 18\" />\n    </symbol>\n    <symbol id=\"chevronLeftIcon\" viewBox=\"0 0 24 24\">\n        <path d=\"M15 19l-7-7 7-7\" />\n    </symbol>\n    <symbol id=\"chevronRightIcon\" viewBox=\"0 0 24 24\">\n        <path d=\"M9 5l7 7-7 7\" />\n    </symbol>\n    <symbol id=\"exitFullscreenIcon\" viewBox=\"0 0 24 24\">\n        <path\n            d=\"M8 15.0996C8.49706 15.0996 8.90039 15.5029 8.90039 16V21C8.90039 21.4971 8.49706 21.9004 8 21.9004C7.50294 21.9004 7.09961 21.4971 7.09961 21V16.9004H3C2.50294 16.9004 2.09961 16.4971 2.09961 16C2.09961 15.5029 2.50294 15.0996 3 15.0996H8Z\"\n        />\n        <path\n            d=\"M21 15.0996C21.4971 15.0996 21.9004 15.5029 21.9004 16C21.9004 16.4971 21.4971 16.9004 21 16.9004H16.9004V21C16.9004 21.4971 16.4971 21.9004 16 21.9004C15.5029 21.9004 15.0996 21.4971 15.0996 21V16C15.0996 15.5029 15.5029 15.0996 16 15.0996H21Z\"\n        />\n        <path\n            d=\"M8 2.09961C8.49706 2.09961 8.90039 2.50294 8.90039 3V8C8.90039 8.49706 8.49706 8.90039 8 8.90039H3C2.50294 8.90039 2.09961 8.49706 2.09961 8C2.09961 7.50294 2.50294 7.09961 3 7.09961H7.09961V3C7.09961 2.50294 7.50294 2.09961 8 2.09961Z\"\n        />\n        <path\n            d=\"M16 2.09961C16.4971 2.09961 16.9004 2.50294 16.9004 3V7.09961H21C21.4971 7.09961 21.9004 7.50294 21.9004 8C21.9004 8.49706 21.4971 8.90039 21 8.90039H16C15.5029 8.90039 15.0996 8.49706 15.0996 8V3C15.0996 2.50294 15.5029 2.09961 16 2.09961Z\"\n        />\n    </symbol>\n</svg>\n";

/**
 * Creates a figure-8 (lemniscate / infinity sign) camera animation track.
 * The camera traces a horizontal figure-8 centered at its initial position
 * while looking at the target point.
 *
 * @param position - Starting location of the camera.
 * @param target - Target point the camera looks at.
 * @param fov - The camera field of view.
 * @param size - Controls the scale of the figure-8 path. The left-right extent equals `size`
 * and the forward-back extent is half that (`size * 0.5`).
 * @param keys - The number of keyframes in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns The animation track object containing position and target keyframes.
 */
const createFigure8Track = (position, target, fov, size = 1, keys = 24, duration = 20) => {
    const times = new Array(keys).fill(0).map((_, i) => (i / keys) * duration);
    const positions = [];
    const targets = [];
    const fovs = new Array(keys).fill(fov);
    const amplitude = size * 0.5;
    const dx = position.x - target.x;
    const dz = position.z - target.z;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    // compute local horizontal axes relative to camera-target direction
    let rightX, rightZ;
    let fwdX, fwdZ;
    if (horizontalDist > 0.001) {
        fwdX = dx / horizontalDist;
        fwdZ = dz / horizontalDist;
        rightX = -fwdZ;
        rightZ = fwdX;
    }
    else {
        fwdX = 0;
        fwdZ = 1;
        rightX = 1;
        rightZ = 0;
    }
    for (let i = 0; i < keys; ++i) {
        const t = (i / keys) * Math.PI * 2;
        // lemniscate offsets: sin(t) for left-right, sin(2t)/2 for forward-back
        const offsetRight = amplitude * Math.sin(t);
        const offsetFwd = (amplitude * Math.sin(2 * t)) / 2;
        positions.push(position.x + rightX * offsetRight + fwdX * offsetFwd);
        positions.push(position.y);
        positions.push(position.z + rightZ * offsetRight + fwdZ * offsetFwd);
        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }
    return {
        name: 'figure8',
        duration,
        frameRate: 1,
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets,
                fov: fovs
            }
        }
    };
};

/**
 * Creates a rotation animation track
 *
 * @param position - Starting location of the camera.
 * @param target - Target point around which to rotate
 * @param fov - The camera field of view.
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (position, target, fov, keys = 12, duration = 20) => {
    const times = new Array(keys).fill(0).map((_, i) => (i / keys) * duration);
    const positions = [];
    const targets = [];
    const fovs = new Array(keys).fill(fov);
    const dx = position.x - target.x;
    const dy = position.y - target.y;
    const dz = position.z - target.z;
    const horizontalRadius = Math.sqrt(dx * dx + dz * dz);
    const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // when the offset is nearly vertical, use a fraction of the total distance
    // as the orbit radius so the camera actually moves in a circle
    const minRadius = totalDist * 0.3;
    const radius = Math.max(horizontalRadius, minRadius);
    const startAngle = Math.atan2(dx, dz);
    for (let i = 0; i < keys; ++i) {
        const angle = startAngle - (i / keys) * Math.PI * 2;
        positions.push(target.x + radius * Math.sin(angle));
        positions.push(target.y + dy);
        positions.push(target.z + radius * Math.cos(angle));
        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }
    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets,
                fov: fovs
            }
        }
    };
};

/**
 * Damping function to smooth out transitions.
 *
 * @param damping - Damping factor (0 < damping < 1).
 * @param dt - Delta time in seconds.
 * @returns - Damping factor adjusted for the delta time.
 */
const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);
/**
 * Easing function for smooth transitions.
 *
 * @param x - Input value in the range [0, 1].
 * @returns - Output value in the range [0, 1].
 */
const easeOut = (x) => (1 - 2 ** (-10 * x)) / (1 - 2 ** -10);
/**
 * Modulus function that handles negative values correctly.
 *
 * @param n - The number to be modulated.
 * @param m - The modulus value.
 * @returns - The result of n mod m, adjusted to be non-negative.
 */
const mod = (n, m) => ((n % m) + m) % m;
const nearlyEquals = (a, b, epsilon = 1e-4) => {
    return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
};
const vecToAngles = (result, vec) => {
    const radToDeg = 180 / Math.PI;
    const horizLenSq = vec.x * vec.x + vec.z * vec.z;
    result.x = Math.asin(Math.max(-1, Math.min(1, vec.y))) * radToDeg;
    result.y = horizLenSq > 1e-8 ? Math.atan2(-vec.x, -vec.z) * radToDeg : 0;
    result.z = 0;
    return result;
};

/**
 * Shared damping factor for controller smoothing (rotate / move / zoom) so
 * orbit, fly, and walk feel the same. Used as `damp(damping, dt)` →
 * `1 - damping^(dt*1000)`. Higher means smoother / more lag. Not used for
 * physics-style velocity decay (e.g. walk's grounded/air velocity damping),
 * which has different tuning needs.
 */
const DEFAULT_CONTROLLER_DAMPING = 0.95;
const rotation$1 = new Quat();
/**
 * Apply a CameraFrame rotate delta to camera Euler angles.
 *
 * CameraFrame rotate uses [yaw, pitch, roll]-style input deltas, while camera
 * angles are stored as [pitch, yaw, roll].
 *
 * @param angles - Camera Euler angles to mutate.
 * @param rotate - Frame rotate delta.
 * @param minPitch - Minimum pitch angle in degrees.
 * @param maxPitch - Maximum pitch angle in degrees.
 * @returns The mutated angles.
 */
const applyFrameRotation = (angles, rotate, minPitch = -90, maxPitch = 90) => {
    angles.x -= rotate[1];
    angles.y -= rotate[0];
    angles.z = 0;
    angles.x = math.clamp(angles.x, minPitch, maxPitch);
    return angles;
};
/**
 * Calculate camera-relative basis vectors from Euler angles.
 *
 * @param angles - Camera Euler angles in degrees.
 * @param forward - Receives the forward vector.
 * @param right - Receives the right vector.
 * @param up - Receives the up vector.
 */
const setCameraBasis = (angles, forward, right, up) => {
    rotation$1.setFromEulerAngles(angles);
    rotation$1.transformVector(Vec3.FORWARD, forward);
    rotation$1.transformVector(Vec3.RIGHT, right);
    rotation$1.transformVector(Vec3.UP, up);
};
/**
 * Calculate a camera forward vector from Euler angles.
 *
 * @param angles - Camera Euler angles in degrees.
 * @param forward - Receives the forward vector.
 */
const setCameraForward = (angles, forward) => {
    rotation$1.setFromEulerAngles(angles);
    rotation$1.transformVector(Vec3.FORWARD, forward);
};
/**
 * Calculate yaw-only movement basis vectors.
 *
 * @param yaw - Camera yaw angle in degrees.
 * @param forward - Receives the horizontal forward vector.
 * @param right - Receives the horizontal right vector.
 */
const setYawBasis = (yaw, forward, right) => {
    rotation$1.setFromEulerAngles(0, yaw, 0);
    rotation$1.transformVector(Vec3.FORWARD, forward);
    rotation$1.transformVector(Vec3.RIGHT, right);
};
/**
 * Build a world-space offset from local movement along camera basis vectors.
 *
 * @param out - Receives the world-space offset.
 * @param x - Local right movement.
 * @param y - Local up movement.
 * @param z - Local forward movement.
 * @param forward - Forward basis vector.
 * @param right - Right basis vector.
 * @param up - Up basis vector.
 * @returns The mutated output vector.
 */
const setBasisOffset = (out, x, y, z, forward, right, up) => {
    out.set(right.x * x + up.x * y + forward.x * z, right.y * x + up.y * y + forward.y * z, right.z * x + up.z * y + forward.z * z);
    return out;
};
/**
 * Lerp Euler angles toward a target using frame-rate-independent shortest-path
 * interpolation. Yaw/roll on both `angles` and `target` are wrapped into
 * `[0, 360)` so `lerpAngle`'s single-shift shortest-path stays valid after
 * many full rotations (otherwise the camera takes the long way around). Pitch
 * is left untouched since callers clamp it.
 *
 * @param angles - Current angles, mutated toward target.
 * @param target - Target angles. Yaw/roll are wrapped in place to keep
 * accumulated drift bounded across frames.
 * @param damping - Damping factor in [0, 1]. Higher = smoother (1 = never moves).
 * @param dt - Delta time in seconds.
 * @returns The mutated angles.
 */
const dampAngles = (angles, target, damping, dt) => {
    if (dt <= 0) {
        return angles;
    }
    const t = damp(damping, dt);
    angles.y = mod(angles.y, 360);
    angles.z = mod(angles.z, 360);
    target.y = mod(target.y, 360);
    target.z = mod(target.z, 360);
    angles.x = math.lerpAngle(angles.x, target.x, t);
    angles.y = math.lerpAngle(angles.y, target.y, t);
    angles.z = math.lerpAngle(angles.z, target.z, t);
    return angles;
};
/**
 * Discard any pending input deltas in the frame. `InputFrame.read()` zeros
 * deltas as a side-effect of reading, so calling this prevents accumulated
 * input from leaking into the next controller when a non-input-driven mode
 * (e.g. animation) is active.
 *
 * @param frame - The camera frame whose deltas should be drained.
 */
const drainInputFrame = (frame) => {
    frame.read();
};

class CubicSpline {
    // control times
    times;
    // control data: in-tangent, point, out-tangent
    knots;
    // dimension of the knot points
    dim;
    constructor(times, knots) {
        this.times = times;
        this.knots = knots;
        this.dim = knots.length / times.length / 3;
    }
    evaluate(time, result) {
        const { times } = this;
        const last = times.length - 1;
        if (time <= times[0]) {
            this.getKnot(0, result);
        }
        else if (time >= times[last]) {
            this.getKnot(last, result);
        }
        else {
            let seg = 0;
            while (time >= times[seg + 1]) {
                seg++;
            }
            this.evaluateSegment(seg, (time - times[seg]) / (times[seg + 1] - times[seg]), result);
        }
    }
    getKnot(index, result) {
        const { knots, dim } = this;
        const idx = index * 3 * dim;
        for (let i = 0; i < dim; ++i) {
            result[i] = knots[idx + i * 3 + 1];
        }
    }
    // evaluate the spline segment at the given normalized time t
    evaluateSegment(segment, t, result) {
        const { knots, dim } = this;
        const t2 = t * t;
        const twot = t + t;
        const omt = 1 - t;
        const omt2 = omt * omt;
        let idx = segment * dim * 3; // each knot has 3 values: tangent in, value, tangent out
        for (let i = 0; i < dim; ++i) {
            const p0 = knots[idx + 1]; // p0
            const m0 = knots[idx + 2]; // outgoing tangent
            const m1 = knots[idx + dim * 3]; // incoming tangent
            const p1 = knots[idx + dim * 3 + 1]; // p1
            idx += 3;
            result[i] = p0 * ((1 + twot) * omt2) + m0 * (t * omt2) + p1 * (t2 * (3 - twot)) + m1 * (t2 * (t - 1));
        }
    }
    // calculate cubic spline knots from points
    // times: time values for each control point
    // points: control point values to be interpolated (n dimensional)
    // smoothness: 0 = linear, 1 = smooth
    static calcKnots(times, points, smoothness) {
        const n = times.length;
        const dim = points.length / n;
        const knots = new Array(n * dim * 3);
        for (let i = 0; i < n; i++) {
            const t = times[i];
            for (let j = 0; j < dim; j++) {
                const idx = i * dim + j;
                const p = points[idx];
                let tangent;
                if (i === 0) {
                    tangent = (points[idx + dim] - p) / (times[i + 1] - t);
                }
                else if (i === n - 1) {
                    tangent = (p - points[idx - dim]) / (t - times[i - 1]);
                }
                else {
                    tangent = (points[idx + dim] - points[idx - dim]) / (times[i + 1] - times[i - 1]);
                }
                // convert to derivatives w.r.t normalized segment parameter
                const inScale = i > 0 ? times[i] - times[i - 1] : times[1] - times[0];
                const outScale = i < n - 1 ? times[i + 1] - times[i] : times[i] - times[i - 1];
                knots[idx * 3] = tangent * inScale * smoothness;
                knots[idx * 3 + 1] = p;
                knots[idx * 3 + 2] = tangent * outScale * smoothness;
            }
        }
        return knots;
    }
    static fromPoints(times, points, smoothness = 1) {
        return new CubicSpline(times, CubicSpline.calcKnots(times, points, smoothness));
    }
    // create a looping spline by duplicating animation points at the end and beginning
    static fromPointsLooping(length, times, points, smoothness = 1) {
        if (times.length < 2) {
            return CubicSpline.fromPoints(times, points);
        }
        const dim = points.length / times.length;
        const newTimes = times.slice();
        const newPoints = points.slice();
        // append first two points
        newTimes.push(length + times[0], length + times[1]);
        newPoints.push(...points.slice(0, dim * 2));
        // prepend last two points
        newTimes.splice(0, 0, times[times.length - 2] - length, times[times.length - 1] - length);
        newPoints.splice(0, 0, ...points.slice(points.length - dim * 2));
        return CubicSpline.fromPoints(newTimes, newPoints, smoothness);
    }
}

// track an animation cursor with support for repeat and ping-pong loop modes
class AnimCursor {
    duration = 0;
    loopMode = 'none';
    timer = 0;
    cursor = 0;
    constructor(duration, loopMode) {
        this.reset(duration, loopMode);
    }
    update(deltaTime) {
        // update animation timer
        this.timer += deltaTime;
        // update the track cursor
        this.cursor += deltaTime;
        if (this.cursor >= this.duration) {
            switch (this.loopMode) {
                case 'none':
                    this.cursor = this.duration;
                    break;
                case 'repeat':
                    this.cursor %= this.duration;
                    break;
                case 'pingpong':
                    this.cursor %= this.duration * 2;
                    break;
            }
        }
    }
    reset(duration, loopMode) {
        this.duration = duration;
        this.loopMode = loopMode;
        this.timer = 0;
        this.cursor = 0;
    }
    // true once a play-once animation has reached the end of the track
    get ended() {
        return this.loopMode === 'none' && this.cursor >= this.duration;
    }
    set value(value) {
        // 'repeat' wraps (the end is the start); 'none' and 'pingpong' clamp so a
        // scrub to the exact end parks on the last frame instead of wrapping to 0
        this.cursor =
            this.loopMode === 'repeat' ? mod(value, this.duration) : Math.max(0, Math.min(this.duration, value));
    }
    get value() {
        return this.cursor > this.duration ? 2 * this.duration - this.cursor : this.cursor;
    }
}

// manage the state of a camera animation track
class AnimState {
    spline;
    cursor = new AnimCursor(0, 'none');
    frameRate;
    result = [];
    position = new Vec3();
    target = new Vec3();
    fov = 90;
    constructor(spline, duration, loopMode, frameRate) {
        this.spline = spline;
        this.cursor.reset(duration, loopMode);
        this.frameRate = frameRate;
    }
    // update given delta time
    update(dt) {
        const { cursor, result, spline, frameRate, position, target } = this;
        // update the animation cursor
        cursor.update(dt);
        // evaluate the spline
        spline.evaluate(cursor.value * frameRate, result);
        if (result.every(isFinite)) {
            position.set(result[0], result[1], result[2]);
            target.set(result[3], result[4], result[5]);
            this.fov = result[6];
        }
    }
    // construct an animation from a settings track
    static fromTrack(track) {
        const { keyframes, duration, frameRate, loopMode, smoothness } = track;
        const { times, values } = keyframes;
        const { position, target, fov } = values;
        // construct the points array containing position, target and fov
        const points = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
            points.push(fov[i]);
        }
        const extra = duration === times[times.length - 1] / frameRate ? 1 : 0;
        // 'repeat' wraps the path from the last key back to the first; 'none' and
        // 'pingpong' clamp at the outer keys, holding the end poses instead
        const spline = loopMode === 'repeat'
            ? CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness)
            : CubicSpline.fromPoints(times, points, smoothness);
        return new AnimState(spline, duration, loopMode, frameRate);
    }
}

class AnimController {
    animState;
    constructor(animTrack) {
        this.animState = AnimState.fromTrack(animTrack);
        this.animState.update(0);
    }
    onEnter(camera) {
        camera.look(this.animState.position, this.animState.target);
        camera.fov = this.animState.fov;
    }
    update(deltaTime, inputFrame, camera) {
        this.animState.update(deltaTime);
        camera.look(this.animState.position, this.animState.target);
        camera.fov = this.animState.fov;
        drainInputFrame(inputFrame);
    }
    onExit(_camera) {
        // no cleanup needed
    }
}

const rotation = new Quat();
const avec = new Vec3();
const bvec = new Vec3();
class Camera {
    position = new Vec3();
    angles = new Vec3();
    distance = 1;
    fov = 65;
    constructor(other) {
        if (other) {
            this.copy(other);
        }
    }
    copy(source) {
        this.position.copy(source.position);
        this.angles.copy(source.angles);
        this.distance = source.distance;
        this.fov = source.fov;
    }
    lerp(a, b, t) {
        a.calcFocusPoint(avec);
        b.calcFocusPoint(bvec);
        this.position.lerp(a.position, b.position, t);
        avec.lerp(avec, bvec, t).sub(this.position);
        this.distance = avec.length();
        vecToAngles(this.angles, avec.mulScalar(1.0 / this.distance));
        this.fov = math.lerp(a.fov, b.fov, t);
    }
    // Blend position, view angles and distance directly, rather than through the look-at
    // point as `lerp` does: the view then turns steadily across the move, the heading the
    // shorter way round, and with the horizon kept level. `turn` is the angles' own progress,
    // so the view can turn ahead of the travel.
    lerpAngles(a, b, t, turn = t) {
        this.position.lerp(a.position, b.position, t);
        this.angles.x = math.lerp(a.angles.x, b.angles.x, turn);
        this.angles.y = a.angles.y + (mod(b.angles.y - a.angles.y + 180, 360) - 180) * turn;
        this.angles.z = math.lerp(a.angles.z, b.angles.z, turn);
        this.distance = math.lerp(a.distance, b.distance, t);
        this.fov = math.lerp(a.fov, b.fov, t);
    }
    look(from, to) {
        this.position.copy(from);
        this.distance = from.distance(to);
        const dir = avec.sub2(to, from).normalize();
        vecToAngles(this.angles, dir);
    }
    calcFocusPoint(result) {
        rotation
            .setFromEulerAngles(this.angles)
            .transformVector(Vec3.FORWARD, result)
            .mulScalar(this.distance)
            .add(this.position);
    }
}

/**
 * Captures a controller's pose at its initial spawn so it can be restored
 * later (e.g. via the "reset" UI gesture). Shared by fly and walk controllers
 * which both implement `resetToSpawn`.
 *
 * Position / angles / distance are the basic camera-pose components. Callers
 * with extra controller-specific state (e.g. walk's grounded flag) keep that
 * alongside as a separate field.
 */
class SpawnState {
    _position = new Vec3();
    _angles = new Vec3();
    _distance = 1;
    _has = false;
    /**
     * True once `store` has been called at least once.
     *
     * @returns Whether a spawn pose has been captured.
     */
    get has() {
        return this._has;
    }
    /**
     * Capture the given pose as the spawn state.
     *
     * @param position - World-space position to remember.
     * @param angles - Euler angles to remember.
     * @param distance - Camera distance (orbit-style) to remember.
     */
    store(position, angles, distance) {
        this._position.copy(position);
        this._angles.copy(angles);
        this._distance = distance;
        this._has = true;
    }
    /**
     * Forget any previously-stored spawn pose so a subsequent `has` check
     * reports false. Used by controllers that scope spawn to a single mode
     * entry (e.g. walk).
     */
    clear() {
        this._has = false;
    }
    /**
     * Copy the captured pose into the supplied targets. Caller must check
     * `has` first; calling `restore` before `store` returns the field
     * defaults (position and angles zeroed, distance `1`).
     *
     * @param position - Mutated with the stored world position.
     * @param angles - Mutated with the stored Euler angles.
     * @returns The stored camera distance.
     */
    restore(position, angles) {
        position.copy(this._position);
        angles.copy(this._angles);
        return this._distance;
    }
}

/** Small clearance that keeps the sphere from resting exactly on a collision surface */
const COLLISION_SKIN = 1e-3;
/** Maximum surface planes to slide along in a single frame */
const MAX_SLIDE_ITERATIONS = 3;
const MIN_MOVE_SQ = 1e-10;
const INV_SQRT2 = 1 / Math.sqrt(2);
const SWEEP_RAY_OFFSETS = [
    [0, 0, true],
    [1, 0, false],
    [-1, 0, false],
    [0, 1, false],
    [0, -1, false],
    [INV_SQRT2, INV_SQRT2, false],
    [-INV_SQRT2, INV_SQRT2, false],
    [-INV_SQRT2, -INV_SQRT2, false],
    [INV_SQRT2, -INV_SQRT2, false]
];
const v$1 = new Vec3();
const remainingMove = new Vec3();
const collisionPush = new Vec3();
const sweepDir = new Vec3();
const sweepNormal = new Vec3();
const sweepTangent = new Vec3();
const sweepBitangent = new Vec3();
const sweepOrigin = new Vec3();
const worldUp = new Vec3(0, 1, 0);
const worldRight = new Vec3(1, 0, 0);
/** Pre-allocated push-out vector for sphere collision */
const pushOut = { x: 0, y: 0, z: 0 };
const sweepHit = {
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    travel: 0
};
class SphereMover {
    collision = null;
    radius;
    _lastClearPosition = new Vec3();
    _hasLastClearPosition = false;
    constructor(radius) {
        this.radius = radius;
    }
    reset(position) {
        this._setLastClearPosition(position);
    }
    move(position, move) {
        if (!this.collision) {
            position.add(move);
            this._setLastClearPosition(position);
            return;
        }
        remainingMove.copy(move);
        if (this._isMoveComplete(remainingMove)) {
            this.resolve(position);
            return;
        }
        for (let i = 0; i < MAX_SLIDE_ITERATIONS; i++) {
            if (this._isMoveComplete(remainingMove)) {
                break;
            }
            if (!this._moveAndSlide(position, remainingMove)) {
                break;
            }
        }
    }
    resolve(position) {
        if (!this.collision) {
            this._setLastClearPosition(position);
            return;
        }
        this._resolveSphere(position, collisionPush);
        if (!this._isSphereClear(position) && this._hasLastClearPosition) {
            position.copy(this._lastClearPosition);
        }
        if (this._isSphereClear(position)) {
            this._setLastClearPosition(position);
        }
    }
    _moveAndSlide(position, move) {
        const moveSq = move.x * move.x + move.y * move.y + move.z * move.z;
        const distance = Math.sqrt(moveSq);
        sweepDir.copy(move).mulScalar(1 / distance);
        if (!this._querySweep(position, sweepDir, distance, sweepHit)) {
            position.add(move);
            this.resolve(position);
            return false;
        }
        position.add(v$1.copy(sweepDir).mulScalar(sweepHit.travel));
        this.resolve(position);
        sweepNormal.set(sweepHit.nx, sweepHit.ny, sweepHit.nz);
        move.add(v$1.copy(sweepDir).mulScalar(-sweepHit.travel));
        this._clipMove(move, sweepNormal);
        return true;
    }
    _querySweep(position, dir, distance, out) {
        if (Math.abs(dir.y) < 0.99) {
            sweepTangent.cross(dir, worldUp).normalize();
        }
        else {
            sweepTangent.cross(dir, worldRight).normalize();
        }
        sweepBitangent.cross(dir, sweepTangent).normalize();
        let found = false;
        let bestTravel = Infinity;
        for (let i = 0; i < SWEEP_RAY_OFFSETS.length; i++) {
            const [tx, ty, centerRay] = SWEEP_RAY_OFFSETS[i];
            const radiusOffset = centerRay ? 0 : this.radius;
            const rayExtension = centerRay ? this.radius : 0;
            sweepOrigin.copy(position);
            if (!centerRay) {
                sweepOrigin.add(v$1.copy(sweepTangent).mulScalar(tx * radiusOffset));
                sweepOrigin.add(v$1.copy(sweepBitangent).mulScalar(ty * radiusOffset));
            }
            const hit = this.collision.queryRay(sweepOrigin.x, sweepOrigin.y, sweepOrigin.z, dir.x, dir.y, dir.z, distance + rayExtension + COLLISION_SKIN);
            if (!hit) {
                continue;
            }
            const hx = hit.x - sweepOrigin.x;
            const hy = hit.y - sweepOrigin.y;
            const hz = hit.z - sweepOrigin.z;
            const hitDistance = Math.max(0, hx * dir.x + hy * dir.y + hz * dir.z);
            const clearance = centerRay ? this.radius : 0;
            const travel = math.clamp(hitDistance - clearance - COLLISION_SKIN, 0, distance);
            if (travel >= bestTravel) {
                continue;
            }
            const surfaceNormal = this.collision.querySurfaceNormal(hit.x, hit.y, hit.z, dir.x, dir.y, dir.z);
            found = true;
            bestTravel = travel;
            out.x = hit.x;
            out.y = hit.y;
            out.z = hit.z;
            out.nx = surfaceNormal.nx;
            out.ny = surfaceNormal.ny;
            out.nz = surfaceNormal.nz;
            out.travel = travel;
        }
        return found;
    }
    _resolveSphere(position, push) {
        // `querySphere` is already corner-aware (resolveIterative inside the
        // collider iterates up to 4 passes with constraint-normal projection),
        // so a single call here is enough.
        if (!this.collision.querySphere(position.x, position.y, position.z, this.radius, pushOut)) {
            push.set(0, 0, 0);
            return false;
        }
        position.x += pushOut.x;
        position.y += pushOut.y;
        position.z += pushOut.z;
        push.x = pushOut.x;
        push.y = pushOut.y;
        push.z = pushOut.z;
        return true;
    }
    _clipMove(move, push) {
        const normalSq = push.x * push.x + push.y * push.y + push.z * push.z;
        if (normalSq <= MIN_MOVE_SQ) {
            return;
        }
        const invPushLen = 1 / Math.sqrt(normalSq);
        const nx = push.x * invPushLen;
        const ny = push.y * invPushLen;
        const nz = push.z * invPushLen;
        const dot = move.x * nx + move.y * ny + move.z * nz;
        if (dot < 0) {
            move.x -= dot * nx;
            move.y -= dot * ny;
            move.z -= dot * nz;
        }
    }
    _isMoveComplete(move) {
        return move.x * move.x + move.y * move.y + move.z * move.z <= MIN_MOVE_SQ;
    }
    _isSphereClear(position) {
        return !this.collision.querySphere(position.x, position.y, position.z, this.radius, pushOut);
    }
    _setLastClearPosition(position) {
        this._lastClearPosition.copy(position);
        this._hasLastClearPosition = !this.collision || this._isSphereClear(position);
    }
}

/**
 * Maximum Euclidean distance (metres) from the spawn origin to search for a valid placement.
 * Used by the cylinder search, which has to reach far enough to find a standable floor. The
 * sphere search sizes itself from its own radius instead — see `SPHERE_SEARCH_REACH_RADII`.
 */
const SEARCH_RADIUS = 5;
const SEARCH_RADIUS_SQ = SEARCH_RADIUS * SEARCH_RADIUS;
/**
 * Reach of the sphere search, in multiples of the sphere's radius.
 *
 * Its job is to un-clip a sphere that is intersecting a surface, not to relocate one that is deep
 * inside geometry — `FlyController` holds collision until the camera is clear rather than relying
 * on a rescue — so reaching a few radii is enough. Bounding the reach is what makes the search
 * cheap: at radius 0.2 on a 0.05 m grid the worst case, finding nothing, is 7,153 probes, where
 * reaching `SEARCH_RADIUS` cost 8,120,601. A sphere deep inside geometry never finds a free cell
 * to tighten `bestDistSq`, so nothing breaks the search early and it pays for every shell.
 *
 * The lattice still steps by `collision.voxelResolution`, deliberately. A coarser step is not
 * safe: the valid positions for a collider's centre are free space eroded by its radius, which
 * can be far narrower than the free space itself. A 0.45 m passage admits a 0.2 m sphere across
 * only a 0.05 m band of centres, so a 0.1 m lattice steps straight over it and reports no
 * placement at all.
 */
const SPHERE_SEARCH_REACH_RADII = 3;
/** Ray budget when probing for ground/ceiling under or above a candidate column. */
const RAY_MAX_DIST = 1000;
// Scratch values reused across calls — these helpers run only at spawn time
// so the lack of re-entrancy is fine.
const scratchPush = { x: 0, y: 0, z: 0 };
/**
 * Find the closest sphere placement to (ox, oy, oz) where a sphere of `radius`
 * fits clear of geometry. Output is the sphere centre. Used for fly-camera
 * spawn — fly cameras have no ground constraint.
 *
 * Lattice search across voxel-spaced offsets from the origin (step =
 * `collision.voxelResolution`), ordered by Chebyshev shell with Euclidean
 * tie-break within a shell. Reach is derived from `radius` — see
 * `SPHERE_SEARCH_REACH_RADII`.
 *
 * @param collision - Active collision implementation.
 * @param ox - Origin X (world space).
 * @param oy - Origin Y (world space).
 * @param oz - Origin Z (world space).
 * @param radius - Sphere radius.
 * @param out - Receives the sphere centre on success.
 * @returns True if a valid placement was found.
 */
const findSphereSpawn = (collision, ox, oy, oz, radius, out) => {
    const step = collision.voxelResolution;
    const reach = radius * SPHERE_SEARCH_REACH_RADII;
    const reachSq = reach * reach;
    const maxCells = Math.ceil(reach / step);
    let bestDistSq = Infinity;
    let found = false;
    for (let r = 0; r <= maxCells; r++) {
        const shellMinDistSq = r * step * (r * step);
        if (shellMinDistSq >= bestDistSq)
            break;
        for (let dy = -r; dy <= r; dy++) {
            const absDy = dy < 0 ? -dy : dy;
            for (let dz = -r; dz <= r; dz++) {
                const absDz = dz < 0 ? -dz : dz;
                // Enumerate the Chebyshev shell of radius r directly instead of scanning the
                // whole cube and skipping its interior. A row is fully on the shell when dy or dz
                // is already at the extreme; otherwise only its two end cells are, so dx jumps
                // straight across the interior. `full` is always true at r = 0, so the stride is
                // never zero.
                const full = absDy === r || absDz === r;
                const dxStep = full ? 1 : 2 * r;
                for (let dx = -r; dx <= r; dx += dxStep) {
                    const distSq = (dx * dx + dy * dy + dz * dz) * step * step;
                    if (distSq >= bestDistSq || distSq > reachSq)
                        continue;
                    const cx = ox + dx * step;
                    const cy = oy + dy * step;
                    const cz = oz + dz * step;
                    if (collision.querySphere(cx, cy, cz, radius, scratchPush))
                        continue;
                    bestDistSq = distSq;
                    out.x = cx;
                    out.y = cy;
                    out.z = cz;
                    found = true;
                }
            }
        }
    }
    return found;
};
/**
 * Find the closest standable cylinder placement to (ox, oy, oz). Output is the
 * floor world position the cylinder rests on (highest geometry hit across the
 * footprint). Used for walk-camera spawn.
 *
 * The algorithm:
 *
 * 1. Lattice search for the closest free voxel `C` (per `isFreeAt`) that has
 *    geometry somewhere below — i.e. a downward ray from `C` hits.
 * 2. At `(C.x, C.z)`, fan rays up and down from `C.y` through every cell
 *    (step = `collision.voxelResolution`) within the xz footprint disc.
 *    Compute, across columns:
 *      - `floor = max(yDown_i)`         (highest ground in the footprint)
 *      - `ceiling = min(yUp_i)`         (lowest obstruction overhead, or ∞)
 *    Every column must have a `yDown` hit; otherwise the cylinder is partly
 *    unsupported and the candidate is discarded.
 * 3. The cylinder fits iff `floor + halfHeight ≤ ceiling - halfHeight`,
 *    i.e. enough vertical clearance for the full cylinder above the floor.
 *    The "resting on ground" placement has centre at `floor + halfHeight`.
 *
 * Cylinder math (flat ends, no hemispheres) intentionally matches the carve,
 * which used a separable XYZ dilation.
 *
 * @param collision - Active collision implementation.
 * @param ox - Origin X (world space).
 * @param oy - Origin Y (world space).
 * @param oz - Origin Z (world space).
 * @param halfHeight - Cylinder half-height (full height = 2 × halfHeight).
 * @param radius - Cylinder radius.
 * @param out - Receives the floor position the cylinder rests on.
 * @returns True if a valid placement was found.
 */
const findCylinderSpawn = (collision, ox, oy, oz, halfHeight, radius, out) => {
    const step = collision.voxelResolution;
    const maxCells = Math.ceil(SEARCH_RADIUS / step);
    // Round up so float division (e.g. 0.2 / 0.05) can't accidentally drop
    // the outer ring of footprint cells; the Euclidean check below trims any
    // overshoot back to the true radius.
    const footCells = Math.ceil(radius / step);
    const radiusSq = radius * radius;
    let bestDistSq = Infinity;
    let found = false;
    for (let r = 0; r <= maxCells; r++) {
        const shellMinDistSq = r * step * (r * step);
        if (shellMinDistSq >= bestDistSq)
            break;
        for (let dy = -r; dy <= r; dy++) {
            const absDy = dy < 0 ? -dy : dy;
            for (let dz = -r; dz <= r; dz++) {
                const absDz = dz < 0 ? -dz : dz;
                // Enumerate the Chebyshev shell of radius r directly rather than scanning the
                // whole cube and skipping its interior — see `findSphereSpawn`.
                const full = absDy === r || absDz === r;
                const dxStep = full ? 1 : 2 * r;
                for (let dx = -r; dx <= r; dx += dxStep) {
                    const distSq = (dx * dx + dy * dy + dz * dz) * step * step;
                    if (distSq >= bestDistSq || distSq > SEARCH_RADIUS_SQ)
                        continue;
                    const cx = ox + dx * step;
                    const cy = oy + dy * step;
                    const cz = oz + dz * step;
                    // Stage 1: cheap filter — only consider free voxels.
                    // The footprint loop below will reject candidates whose
                    // center column has no ground support, so no separate
                    // down-ray probe is needed here.
                    if (!collision.isFreeAt(cx, cy, cz))
                        continue;
                    // Stage 2/3: fan rays through the xz footprint.
                    let floor = -Infinity;
                    let ceiling = Infinity;
                    let supported = true;
                    for (let i = -footCells; i <= footCells && supported; i++) {
                        const fxOff = i * step;
                        const fxOffSq = fxOff * fxOff;
                        for (let j = -footCells; j <= footCells; j++) {
                            const fzOff = j * step;
                            if (fxOffSq + fzOff * fzOff > radiusSq)
                                continue;
                            const fx = cx + fxOff;
                            const fz = cz + fzOff;
                            const down = collision.queryRay(fx, cy, fz, 0, -1, 0, RAY_MAX_DIST);
                            if (!down) {
                                supported = false;
                                break;
                            }
                            if (down.y > floor)
                                floor = down.y;
                            const up = collision.queryRay(fx, cy, fz, 0, 1, 0, RAY_MAX_DIST);
                            if (up && up.y < ceiling)
                                ceiling = up.y;
                        }
                    }
                    if (!supported)
                        continue;
                    // Cylinder vertical extent = 2 × halfHeight. Need that
                    // much room between floor and ceiling.
                    if (floor + 2 * halfHeight > ceiling)
                        continue;
                    bestDistSq = distSq;
                    out.x = cx;
                    out.y = floor;
                    out.z = cz;
                    found = true;
                }
            }
        }
    }
    return found;
};

/** Radius of the camera collision sphere (meters) */
const CAMERA_RADIUS = 0.2;
const forward$2 = new Vec3();
const right$2 = new Vec3();
const up$1 = new Vec3();
const offset$1 = new Vec3();
const spawnProbe$1 = new Vec3();
const clearProbe = { x: 0, y: 0, z: 0 };
// Whether the camera sphere fits at `position` without intersecting collision geometry.
const isClear = (collision, position) => !collision.querySphere(position.x, position.y, position.z, CAMERA_RADIUS, clearProbe);
class FlyController {
    fov = 90;
    rotateDamping = DEFAULT_CONTROLLER_DAMPING;
    _position = new Vec3();
    _angles = new Vec3();
    _targetAngles = new Vec3();
    _distance = 1;
    _spawn = new SpawnState();
    _mover = new SphereMover(CAMERA_RADIUS);
    // Collision that arrived while the camera was inside geometry, held until it is somewhere
    // valid. See the `collision` setter.
    _pendingCollision = null;
    // False until `goto` seeds `_position` from a real camera. Collision is normally attached
    // before this controller has ever been entered, and testing clearance against an unseeded
    // position would hold the attachment for no reason and skip the spawn search in `onEnter`.
    _hasPosition = false;
    /** Optional collision for sphere collision with sliding */
    set collision(value) {
        // The viewer reveals the scene before the collision data has downloaded, so fly mode has
        // no collision response until it lands and the camera may already be inside geometry by
        // then. The mover cannot escape a solid region: push-out has nothing to push against and
        // `_clipMove` cancels the movement every frame, so the camera sticks. Hold the
        // attachment until the camera is somewhere valid and let `update` engage it, which keeps
        // the flight the user is already making instead of teleporting them out. `onEnter` falls
        // back to the same hold when its spawn search cannot place the camera.
        if (value && this._hasPosition && !isClear(value, this._position)) {
            this._pendingCollision = value;
            // Detaching the mover is part of holding, not an optimisation. Left engaged it keeps
            // running push-out against geometry it cannot escape; and without the reset,
            // `SphereMover`'s last-clear position still points wherever the camera was before,
            // so `resolve` teleports it back there on the next idle step.
            this._mover.collision = null;
            this._mover.reset(this._position);
            return;
        }
        this._pendingCollision = null;
        this._mover.collision = value;
        this._mover.reset(this._position);
    }
    get collision() {
        return this._mover.collision;
    }
    /**
     * Re-run the engage-or-hold decision at the camera's current position, whether collision is
     * currently engaged or held. The invariant behind the setter: collision is never active while
     * the camera is inside a collider, because the mover cannot escape one.
     */
    _reengage() {
        this.collision = this._mover.collision ?? this._pendingCollision;
    }
    onEnter(camera) {
        this.goto(camera);
        // Entry may follow a previous one that ended with collision held, so start from the
        // collision we have either way and drop that hold. Otherwise the block below would be
        // skipped on re-entry, leaving the spawn search unrun. Whether to hold again is decided
        // fresh, from this entry's position. Mirrors `WalkController.onEnter`.
        const collision = this._mover.collision ?? this._pendingCollision;
        this._pendingCollision = null;
        if (collision) {
            if (findSphereSpawn(collision, this._position.x, this._position.y, this._position.z, CAMERA_RADIUS, spawnProbe$1)) {
                this._position.copy(spawnProbe$1);
            }
            // Engage at the placed position. The search starts at the camera's own cell, so
            // failing it means the camera is inside geometry with no free space within reach to
            // nudge it to; the setter holds collision in that case and `update` engages it once
            // the camera is clear, as it does for a late attachment. Assigning rather than
            // resetting the mover inline keeps the engage-or-hold decision in one place.
            this.collision = collision;
        }
        this._storeSpawn();
    }
    update(deltaTime, inputFrame, camera) {
        // engage a held attachment as soon as the camera flies back into valid space
        if (this._pendingCollision && isClear(this._pendingCollision, this._position)) {
            this._reengage();
        }
        const { move, rotate } = inputFrame.read();
        applyFrameRotation(this._targetAngles, rotate);
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);
        this._step(move);
        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }
    onExit(_camera) {
        // no cleanup needed
    }
    goto(camera) {
        this._hasPosition = true;
        this._position.copy(camera.position);
        this._angles.set(camera.angles.x, camera.angles.y, 0);
        this._targetAngles.copy(this._angles);
        this._distance = camera.distance;
        this._mover.reset(this._position);
    }
    resetToSpawn(camera) {
        if (!this._spawn.has) {
            return false;
        }
        this._distance = this._spawn.restore(this._position, this._angles);
        this._targetAngles.copy(this._angles);
        // A spawn captured while collision was held is itself inside geometry — `onEnter` stores
        // the entry pose whether or not its search could place the camera. Restoring it with
        // collision engaged would put the camera straight back into the stuck state, so re-run
        // the decision instead of assuming the stored pose is valid. This also covers a spawn
        // that was valid when stored and is not now, after a collision swap. `_reengage` resets
        // the mover, which is why the explicit reset is gone.
        this._reengage();
        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;
        return true;
    }
    _storeSpawn() {
        this._spawn.store(this._position, this._angles, this._distance);
    }
    _step(move) {
        setCameraBasis(this._angles, forward$2, right$2, up$1);
        setBasisOffset(offset$1, move[0], move[1], move[2], forward$2, right$2, up$1);
        this._mover.move(this._position, offset$1);
    }
}

const RAD_TO_DEG = 180 / Math.PI;
const shortestAngle = (angle) => (((angle % 360) + 540) % 360) - 180;
const smoothstep = (edge0, edge1, value) => {
    const t = math.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};
const approach = (value, target, maxDelta) => {
    if (value < target) {
        return Math.min(target, value + maxDelta);
    }
    return Math.max(target, value - maxDelta);
};
const smoothTurnRate = (currentRate, angleDiff, maxTurnRate, turnGain, dt) => {
    if (dt <= 0) {
        return currentRate;
    }
    const desiredRate = math.clamp(angleDiff * turnGain, -maxTurnRate, maxTurnRate);
    const smoothing = 1 - Math.exp(-4 * turnGain * dt);
    return currentRate + (desiredRate - currentRate) * smoothing;
};
const clampTurnStep = (rate, remaining, dt) => {
    const step = rate * dt;
    if (Math.abs(remaining) < 1e-4) {
        return 0;
    }
    return Math.sign(step) === Math.sign(remaining) && Math.abs(step) > Math.abs(remaining) ? remaining : step;
};
const getYawToTarget = (dx, dz) => Math.atan2(-dx, -dz) * RAD_TO_DEG;
const getYawDiffToTarget = (dx, dz, yaw) => {
    return shortestAngle(getYawToTarget(dx, dz) - yaw);
};
const getPitchToDirection = (dirY) => {
    return Math.asin(math.clamp(dirY, -1, 1)) * RAD_TO_DEG;
};
class ProgressTracker {
    _blockedTime = 0;
    _prevDist = Infinity;
    reset() {
        this._blockedTime = 0;
        this._prevDist = Infinity;
    }
    update(distance, dt, blockedSpeed, blockedDuration, active = true) {
        if (active && this._prevDist !== Infinity && dt > 0) {
            const speed = (this._prevDist - distance) / dt;
            if (speed < blockedSpeed) {
                this._blockedTime += dt;
                if (this._blockedTime >= blockedDuration) {
                    this._prevDist = distance;
                    return true;
                }
            }
            else {
                this._blockedTime = 0;
            }
        }
        this._prevDist = distance;
        return false;
    }
}

const DEG_TO_RAD = Math.PI / 180;
/** Target-space radius to keep visible at the stopping distance */
const STOP_VIEW_RADIUS = 0.75;
/** Minimum standoff from the target */
const MIN_STOP_DIST = 0.75;
/** Maximum standoff from the target */
const MAX_STOP_DIST = 4.0;
/** Distance from the standoff point below which arrival can complete */
const ARRIVAL_EPSILON = 0.03;
/** Forward speed below which arrival can complete */
const ARRIVAL_SPEED = 0.05;
/** Converts remaining standoff distance to final approach speed */
const ARRIVAL_RATE = 1.75;
/** Minimum progress speed (m/s) to not count as blocked */
const BLOCKED_SPEED$1 = 0.25;
/** Seconds of continuous low-progress before stopping the flight */
const BLOCKED_DURATION$1 = 0.5;
const toTarget = new Vec3();
const forward$1 = new Vec3();
const postTurnAngles = new Vec3();
const getStopDistance = (fov) => {
    const halfFov = math.clamp(fov, 15, 120) * DEG_TO_RAD * 0.5;
    return math.clamp(STOP_VIEW_RADIUS / Math.tan(halfFov), MIN_STOP_DIST, MAX_STOP_DIST);
};
/**
 * Generates synthetic move/rotate input to auto-fly toward a target position.
 */
class FlySource {
    /**
     * Forward input scale (matches InputController.moveSpeed).
     */
    flySpeed = 4;
    /**
     * Maximum pitch/yaw turn rate in degrees per second.
     */
    maxTurnRate = 180;
    /**
     * Proportional gain mapping angular error (degrees) to desired turn rate.
     */
    turnGain = 4;
    /**
     * Maximum forward acceleration in meters per second squared.
     */
    moveAcceleration = 6;
    /**
     * Maximum forward braking in meters per second squared.
     */
    moveDeceleration = 8;
    /**
     * Callback fired when an auto-flight completes or is cancelled.
     */
    onComplete = null;
    _target = null;
    _yawRate = 0;
    _pitchRate = 0;
    _speed = 0;
    _progress = new ProgressTracker();
    _speedMul = 1;
    get isActive() {
        return this._target !== null;
    }
    /**
     * Begin auto-flying toward a world-space target position.
     *
     * @param target - The destination.
     * @param speedMul - Forward-speed multiplier (mirrors gaming-controls
     * shift/ctrl: 4 for boost, 0.25 for slow). Defaults to 1.
     */
    navigateTo(target, speedMul = 1) {
        const wasFlying = this._target !== null;
        if (!this._target) {
            this._target = new Vec3();
        }
        this._target.copy(target);
        this._speedMul = speedMul;
        if (!wasFlying) {
            this._yawRate = 0;
            this._pitchRate = 0;
            this._speed = 0;
        }
        this._progress.reset();
    }
    /**
     * Cancel any active auto-flight.
     */
    cancel() {
        if (this._target) {
            this._target = null;
            this._yawRate = 0;
            this._pitchRate = 0;
            this._speed = 0;
            this._progress.reset();
            this.onComplete?.();
        }
    }
    /**
     * Compute fly deltas and append them to the frame. Must be called before
     * the camera controller reads the frame.
     *
     * @param dt - Frame delta time in seconds.
     * @param camera - The current camera state (read-only).
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt, camera, frame) {
        if (!this._target)
            return;
        const target = this._target;
        const cameraPosition = camera.position;
        const cameraAngles = camera.angles;
        toTarget.sub2(target, cameraPosition);
        const dist = toTarget.length();
        const stopDistance = getStopDistance(camera.fov);
        const remainingDist = dist - stopDistance;
        const activeRemainingDist = Math.max(0, remainingDist);
        if (activeRemainingDist <= ARRIVAL_EPSILON && this._speed <= ARRIVAL_SPEED) {
            this.cancel();
            return;
        }
        if (dt <= 0) {
            return;
        }
        const invDist = 1 / dist;
        const dirX = toTarget.x * invDist;
        const dirY = toTarget.y * invDist;
        const dirZ = toTarget.z * invDist;
        const yawDiff = getYawDiffToTarget(toTarget.x, toTarget.z, cameraAngles.y);
        const pitchDiff = getPitchToDirection(dirY) - cameraAngles.x;
        this._yawRate = smoothTurnRate(this._yawRate, yawDiff, this.maxTurnRate, this.turnGain, dt);
        this._pitchRate = smoothTurnRate(this._pitchRate, pitchDiff, this.maxTurnRate, this.turnGain, dt);
        const yawStep = clampTurnStep(this._yawRate, yawDiff, dt);
        const pitchStep = clampTurnStep(this._pitchRate, pitchDiff, dt);
        this._yawRate = yawStep / dt;
        this._pitchRate = pitchStep / dt;
        // FlyController applies: _angles += [-rotateY, -rotateX, 0]
        frame.deltas.rotate.append([-yawStep, -pitchStep, 0]);
        postTurnAngles.set(cameraAngles.x + pitchStep, cameraAngles.y + yawStep, 0);
        setCameraForward(postTurnAngles, forward$1);
        const alignment = math.clamp(forward$1.x * dirX + forward$1.y * dirY + forward$1.z * dirZ, 0, 1);
        const alignmentScale = smoothstep(0.05, 0.95, alignment);
        const brakeSpeed = Math.sqrt(2 * this.moveDeceleration * activeRemainingDist);
        const arrivalSpeed = activeRemainingDist * ARRIVAL_RATE;
        const maxSpeed = Math.min(this.flySpeed * this._speedMul, brakeSpeed, arrivalSpeed);
        if (maxSpeed > this._speed) {
            this._speed = approach(this._speed, maxSpeed, this.moveAcceleration * alignmentScale * dt);
        }
        else {
            this._speed = approach(this._speed, maxSpeed, this.moveDeceleration * dt);
        }
        const arrivalMove = activeRemainingDist * (1 - Math.exp(-ARRIVAL_RATE * dt));
        const moveDist = Math.min(this._speed * dt, arrivalMove);
        if (moveDist > 0) {
            frame.deltas.move.append([0, 0, moveDist]);
        }
        // Only treat low progress as blocked once the camera is substantially
        // facing the target; otherwise a large turn-in-place would cancel early.
        if (this._progress.update(dist, dt, BLOCKED_SPEED$1, BLOCKED_DURATION$1, alignment > 0.5 && this._speed > BLOCKED_SPEED$1)) {
            this.cancel();
        }
    }
}

const p = new Pose();
class OrbitController {
    controller;
    fov = 90;
    constructor() {
        this.controller = new OrbitController$1();
        this.controller.zoomRange = new Vec2(0.01, Infinity);
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = DEFAULT_CONTROLLER_DAMPING;
        this.controller.moveDamping = DEFAULT_CONTROLLER_DAMPING;
        this.controller.zoomDamping = DEFAULT_CONTROLLER_DAMPING;
    }
    onEnter(camera) {
        this._attach(camera);
    }
    update(deltaTime, inputFrame, camera) {
        const pose = this.controller.update(inputFrame, deltaTime);
        camera.position.copy(pose.position);
        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
        camera.fov = this.fov;
    }
    onExit(_camera) {
        // no cleanup needed
    }
    goto(camera) {
        this.fov = camera.fov;
        this._attach(camera);
    }
    _attach(camera) {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = Math.max(camera.distance, this.controller.zoomRange.x);
        this.controller.attach(p, false);
    }
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;
/** Pre-allocated push-out vector for capsule collision */
const out = { x: 0, y: 0, z: 0 };
const v = new Vec3();
const d = new Vec3();
const forward = new Vec3();
const right$1 = new Vec3();
const moveStep = [0, 0, 0];
const offset = new Vec3();
const spawnProbe = new Vec3();
/**
 * First-person camera controller with spring-damper suspension over collision terrain.
 *
 * Movement is constrained to the horizontal plane (XZ) relative to the camera yaw.
 * Vertical positioning uses a spring-damper system that hovers the capsule above the
 * collision surface, filtering out terrain noise for smooth camera motion. Capsule
 * collision handles walls and obstacles. When airborne, normal gravity applies.
 */
class WalkController {
    /**
     * Field of view in degrees for walk mode.
     */
    fov = 90;
    /**
     * Total capsule height in meters (default: human proportion)
     */
    capsuleHeight = 1.5;
    /**
     * Capsule radius in meters
     */
    capsuleRadius = 0.2;
    /**
     * Camera height from the bottom of the capsule in meters
     */
    eyeHeight = 1.3;
    /**
     * Gravity acceleration in m/s^2
     */
    gravity = 9.8;
    /**
     * Jump velocity in m/s
     */
    jumpSpeed = 4;
    /**
     * Movement speed in m/s when grounded
     */
    moveGroundSpeed = 7;
    /**
     * Movement speed in m/s when in the air (for air control)
     */
    moveAirSpeed = 1;
    /**
     * Rotation damping factor (0 = no damping, 1 = full damping)
     */
    rotateDamping = DEFAULT_CONTROLLER_DAMPING;
    /**
     * Velocity damping factor when grounded (0 = no damping, 1 = full damping)
     */
    velocityDampingGround = 0.99;
    /**
     * Velocity damping factor when in the air (0 = no damping, 1 = full damping)
     */
    velocityDampingAir = 0.998;
    /**
     * Target clearance from capsule bottom to ground surface in meters.
     * The capsule hovers this far above terrain to avoid bouncing on noisy surfaces.
     */
    hoverHeight = 0.2;
    /**
     * Spring stiffness for ground-following suspension (higher = stiffer tracking).
     */
    springStiffness = 800;
    /**
     * Damping coefficient for ground-following suspension.
     * Critical damping is approximately 2 * sqrt(springStiffness).
     */
    springDamping = 57;
    /**
     * Maximum downward raycast distance to search for ground below the capsule.
     */
    groundProbeRange = 1.0;
    _position = new Vec3();
    _prevPosition = new Vec3();
    _angles = new Vec3();
    _targetAngles = new Vec3();
    _distance = 1;
    _spawn = new SpawnState();
    _spawnGrounded = false;
    _velocity = new Vec3();
    _pendingMove = [0, 0, 0];
    _accumulator = 0;
    _grounded = false;
    _jumping = false;
    _jumpHeld = false;
    _collision = null;
    /**
     * Collision held because the capsule is inside geometry, mirroring `FlyController`. While
     * held, `_heldFloorY` stands in for the ground probe so the camera walks on the level it
     * entered at instead of falling, and the capsule check is skipped. `_step` engages it for
     * real as soon as the capsule fits.
     */
    _pendingCollision = null;
    /**
     * Synthetic ground height. Set while `_pendingCollision` is held, and while walk mode is
     * active with no collision at all: the viewer attaches collision after the scene is
     * interactive, so a host can enter walk before the data has arrived.
     */
    _heldFloorY = null;
    // False until `goto` seeds `_position` from a real camera, so an attach before this
    // controller has ever been entered engages directly instead of testing clearance against an
    // unseeded position.
    _hasPosition = false;
    /**
     * Optional collision for capsule collision with sliding. Assigning while the capsule is
     * inside geometry holds the attachment instead: engaged collision cannot escape a solid
     * region, so the capsule keeps the synthetic floor and `_step` engages it once it fits.
     * Collision normally lands this way, after walk mode may already be active.
     */
    set collision(value) {
        if (value && this._hasPosition && !this._capsuleClear(value, this._position)) {
            this._pendingCollision = value;
            this._collision = null;
            this._heldFloorY = this._position.y - this.eyeHeight - this.hoverHeight;
            return;
        }
        this._pendingCollision = null;
        this._heldFloorY = null;
        this._collision = value;
    }
    get collision() {
        return this._collision;
    }
    onEnter(camera) {
        this.goto(camera);
        // Spawn is scoped to this walk-mode entry; reset so a stale spawn from a previous entry
        // can't be restored if this entry fails or has no collision to place against.
        this._spawn.clear();
        // Entry may follow a previous one that ended with collision held, so start from the
        // collision we have either way. Whether to hold again is decided fresh, from this
        // entry's position.
        const collision = this._collision ?? this._pendingCollision;
        // Stand on the entry level until collision can place the capsule. This covers collision
        // that has not arrived yet as well as a spawn search that finds nowhere to go: engaged
        // collision would strand the camera either way, with no floor under the ground probe and
        // nothing for push-out to push against. Held, the user can walk out the way they came,
        // and the setter or `_step` engages collision once the capsule fits.
        this._pendingCollision = null;
        this._collision = null;
        this._heldFloorY = this._position.y - this.eyeHeight - this.hoverHeight;
        this._grounded = true;
        if (collision) {
            // Treat the walk capsule as a tight-superset cylinder for spawn.
            // The carve was produced with a separable XYZ dilation (flat ends,
            // no hemispheres), so cylinder math matches the data exactly.
            // Include `hoverHeight` in the height so the ceiling-clearance
            // check accounts for the placed capsule's full vertical envelope:
            // foot sits at `floor + hoverHeight`, head at `floor + hoverHeight
            // + capsuleHeight`.
            if (findCylinderSpawn(collision, camera.position.x, camera.position.y, camera.position.z, (this.capsuleHeight + this.hoverHeight) * 0.5, this.capsuleRadius, spawnProbe)) {
                // spawnProbe is the floor world position the cylinder rests
                // on. Eye sits hoverHeight + eyeHeight above the floor.
                this._position.set(spawnProbe.x, spawnProbe.y + this.hoverHeight + this.eyeHeight, spawnProbe.z);
                this._storeSpawn();
                // The placement is known to fit, so engage directly rather than re-testing it
                // through the setter's capsule query, which is a different test from the
                // cylinder search and could hold on a hairline disagreement.
                this._heldFloorY = null;
                this._collision = collision;
            }
            else {
                // No placement within reach. The setter holds if the capsule is inside geometry
                // and engages otherwise, which is what `_step` would do on its first step anyway.
                this.collision = collision;
            }
        }
        this._prevPosition.copy(this._position);
    }
    update(deltaTime, inputFrame, camera) {
        const { move, rotate } = inputFrame.read();
        // apply rotation at display rate for responsive mouse look
        applyFrameRotation(this._targetAngles, rotate);
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);
        // accumulate movement input so frames without a physics step don't lose input
        this._pendingMove[0] += move[0];
        this._pendingMove[1] = this._pendingMove[1] || move[1];
        this._pendingMove[2] += move[2];
        this._accumulator = Math.min(this._accumulator + deltaTime, MAX_SUBSTEPS * FIXED_DT);
        const numSteps = Math.floor(this._accumulator / FIXED_DT);
        if (numSteps > 0) {
            const invSteps = 1 / numSteps;
            moveStep[0] = this._pendingMove[0] * invSteps;
            moveStep[1] = this._pendingMove[1];
            moveStep[2] = this._pendingMove[2] * invSteps;
            for (let i = 0; i < numSteps; i++) {
                this._prevPosition.copy(this._position);
                this._step(FIXED_DT, moveStep);
                this._accumulator -= FIXED_DT;
            }
            this._pendingMove[0] = 0;
            this._pendingMove[1] = 0;
            this._pendingMove[2] = 0;
        }
        const alpha = this._accumulator / FIXED_DT;
        camera.position.lerp(this._prevPosition, this._position, alpha);
        camera.angles.set(this._angles.x, this._angles.y, 0);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }
    _step(dt, move) {
        // engage a held attachment as soon as the capsule reaches space it fits in
        if (this._pendingCollision && this._capsuleClear(this._pendingCollision, this._position)) {
            this._collision = this._pendingCollision;
            this._pendingCollision = null;
            this._heldFloorY = null;
        }
        // ground probe: cast a ray downward to find the terrain surface
        const groundY = this._probeGround(this._position);
        const hasGround = groundY !== null;
        // jump (require release before re-triggering)
        if (this._velocity.y < 0) {
            this._jumping = false;
        }
        if (move[1] && !this._jumping && this._grounded && !this._jumpHeld) {
            this._jumping = true;
            this._velocity.y = this.jumpSpeed;
            this._grounded = false;
        }
        this._jumpHeld = !!move[1];
        // vertical force: spring-damper when ground is detected, gravity when airborne
        if (hasGround && !this._jumping) {
            const targetY = groundY + this.hoverHeight + this.eyeHeight;
            const displacement = this._position.y - targetY;
            if (displacement > 0.1) {
                // well above target (jump/ledge): freefall, snap to rest height on arrival
                this._velocity.y -= this.gravity * dt;
                const nextY = this._position.y + this._velocity.y * dt;
                if (nextY <= targetY) {
                    this._position.y = targetY;
                    this._velocity.y = 0;
                }
                this._grounded = false;
            }
            else {
                // at or near target (walking/slopes): spring tracks terrain
                const springForce = -this.springStiffness * displacement - this.springDamping * this._velocity.y;
                this._velocity.y += springForce * dt;
                this._grounded = true;
            }
        }
        else {
            this._velocity.y -= this.gravity * dt;
            this._grounded = false;
        }
        // move
        setYawBasis(this._angles.y, forward, right$1);
        setBasisOffset(offset, move[0], 0, move[2], forward, right$1, Vec3.UP);
        this._velocity.add(offset.mulScalar(this._grounded ? this.moveGroundSpeed : this.moveAirSpeed));
        const dampFactor = this._grounded ? this.velocityDampingGround : this.velocityDampingAir;
        const alpha = damp(dampFactor, dt);
        this._velocity.x = math.lerp(this._velocity.x, 0, alpha);
        this._velocity.z = math.lerp(this._velocity.z, 0, alpha);
        this._position.add(v.copy(this._velocity).mulScalar(dt));
        // capsule collision: walls, ceiling, and fallback floor contact
        this._checkCollision(this._position, d);
    }
    onExit(_camera) {
        // nothing to clean up
    }
    /**
     * Teleport the controller to a given camera state (used for transitions).
     *
     * @param camera - The camera state to jump to.
     */
    goto(camera) {
        // position
        this._hasPosition = true;
        this._position.copy(camera.position);
        this._prevPosition.copy(this._position);
        // angles (clamp pitch to avoid gimbal lock)
        this._angles.set(camera.angles.x, camera.angles.y, 0);
        this._targetAngles.copy(this._angles);
        this._distance = camera.distance;
        // reset velocity and state
        this._resetMotion();
    }
    /**
     * Reset the controller to the spawn pose captured on the last walk-mode entry.
     *
     * @param camera - Camera state to update with the spawn pose.
     * @returns True if a spawn pose was available.
     */
    resetToSpawn(camera) {
        if (!this._spawn.has) {
            return false;
        }
        this._distance = this._spawn.restore(this._position, this._angles);
        this._prevPosition.copy(this._position);
        this._targetAngles.copy(this._angles);
        this._resetMotion();
        this._grounded = this._spawnGrounded;
        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;
        return true;
    }
    _storeSpawn() {
        this._spawn.store(this._position, this._angles, this._distance);
        this._spawnGrounded = this._grounded;
    }
    _resetMotion() {
        this._velocity.set(0, 0, 0);
        this._grounded = false;
        this._jumping = false;
        this._jumpHeld = false;
        this._pendingMove[0] = 0;
        this._pendingMove[1] = 0;
        this._pendingMove[2] = 0;
        this._accumulator = 0;
    }
    /**
     * Whether the walk capsule fits at `pos` without intersecting collision geometry.
     *
     * @param collision - Collision to test against.
     * @param pos - Eye position in PlayCanvas world space.
     * @returns True if the capsule is clear.
     */
    _capsuleClear(collision, pos) {
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        return !collision.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out);
    }
    /**
     * Cast multiple rays downward to find the average ground surface height.
     * Uses 5 rays (center + 4 cardinal at capsule radius) to spatially filter
     * noisy collision heights, giving the spring a smoother target.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @returns Average ground surface Y in PlayCanvas space, or null if no ground found.
     */
    _probeGround(pos) {
        // While collision is held the real surface is unreachable, so stand on the level the
        // camera entered at. Without this the camera reads as airborne and falls.
        if (this._heldFloorY !== null)
            return this._heldFloorY;
        if (!this.collision)
            return null;
        const oy = pos.y - this.eyeHeight;
        const r = this.capsuleRadius;
        const range = this.groundProbeRange;
        let totalY = 0;
        let hitCount = 0;
        for (let i = 0; i < 5; i++) {
            let ox = pos.x;
            let oz = pos.z;
            if (i === 1)
                ox -= r;
            else if (i === 2)
                ox += r;
            else if (i === 3)
                oz += r;
            else if (i === 4)
                oz -= r;
            const hit = this.collision.queryRay(ox, oy, oz, 0, -1, 0, range);
            if (hit) {
                totalY += hit.y;
                hitCount++;
            }
        }
        return hitCount > 0 ? totalY / hitCount : null;
    }
    /**
     * Check for capsule collision and apply push-out displacement.
     * Handles walls, ceiling hits, and fallback floor contact when airborne.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @param disp - Pre-allocated vector to receive the collision push-out displacement.
     */
    _checkCollision(pos, disp) {
        if (!this.collision)
            return;
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        if (this.collision.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out)) {
            disp.set(out.x, out.y, out.z);
            pos.add(disp);
            // ceiling collision: cancel upward velocity
            if (disp.y < 0 && this._velocity.y > 0) {
                this._velocity.y = 0;
            }
            // airborne floor collision: transition to grounded as a fallback safety net
            if (!this._grounded && disp.y > 0 && this._velocity.y < 0) {
                this._velocity.y = 0;
                this._grounded = true;
            }
        }
    }
}

/** XZ distance below which the walker considers itself arrived */
const ARRIVAL_DIST = 0.5;
/** Minimum XZ speed (m/s) to not count as blocked */
const BLOCKED_SPEED = 0.6;
/** Seconds of continuous low-progress before stopping the walk */
const BLOCKED_DURATION = 0.2;
/**
 * Generates synthetic move/rotate input to auto-walk toward a target position.
 *
 * Designed to feed into WalkController's existing update path so there is no
 * duplicated physics. Each frame it appends yaw-rotation and forward-movement
 * deltas to the shared CameraFrame, and monitors arrival / blocked conditions.
 */
class WalkSource {
    /**
     * Forward input scale (matches InputController.moveSpeed for consistent
     * speed with regular WASD walking).
     */
    walkSpeed = 4;
    /**
     * Maximum yaw turn rate in degrees per second.
     */
    maxTurnRate = 192;
    /**
     * Proportional gain mapping yaw error (degrees) to desired turn rate.
     * Below maxTurnRate / turnGain degrees the turn rate scales linearly;
     * above that it is capped at maxTurnRate. The rate filter is
     * automatically critically damped so there is no overshoot.
     */
    turnGain = 5;
    /**
     * Callback fired when an auto-walk completes (arrival or obstacle).
     */
    onComplete = null;
    _target = null;
    _yawRate = 0;
    _progress = new ProgressTracker();
    _speedMul = 1;
    get isActive() {
        return this._target !== null;
    }
    /**
     * Begin auto-walking toward a world-space target position.
     *
     * @param target - The destination (XZ used for navigation).
     * @param speedMul - Forward-speed multiplier (mirrors gaming-controls
     * shift/ctrl: 2 for run, 0.5 for crawl). Defaults to 1.
     */
    navigateTo(target, speedMul = 1) {
        if (!this._target) {
            this._target = new Vec3();
        }
        this._target.copy(target);
        this._speedMul = speedMul;
        this._progress.reset();
    }
    /**
     * Cancel any active auto-walk.
     */
    cancel() {
        if (this._target) {
            this._target = null;
            this._yawRate = 0;
            this._progress.reset();
            this.onComplete?.();
        }
    }
    /**
     * Compute walk deltas and append them to the frame. Must be called
     * before* the camera controller reads the frame.
     *
     * @param dt - Frame delta time in seconds.
     * @param camera - The current camera state (read-only).
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt, camera, frame) {
        if (!this._target)
            return;
        const target = this._target;
        const cameraPosition = camera.position;
        const cameraAngles = camera.angles;
        const dx = target.x - cameraPosition.x;
        const dz = target.z - cameraPosition.z;
        const xzDist = Math.sqrt(dx * dx + dz * dz);
        // arrival
        if (xzDist < ARRIVAL_DIST) {
            this.cancel();
            return;
        }
        // blocked detection: compare with previous frame's distance
        if (this._progress.update(xzDist, dt, BLOCKED_SPEED, BLOCKED_DURATION)) {
            this.cancel();
            return;
        }
        // yaw toward target with smoothed turn rate
        const yawDiff = getYawDiffToTarget(dx, dz, cameraAngles.y);
        this._yawRate = smoothTurnRate(this._yawRate, yawDiff, this.maxTurnRate, this.turnGain, dt);
        const yawStep = clampTurnStep(this._yawRate, yawDiff, dt);
        this._yawRate = dt > 0 ? yawStep / dt : this._yawRate;
        // WalkController applies: _angles.y += -rotate[0]
        frame.deltas.rotate.append([-yawStep, 0, 0]);
        // scale forward speed by alignment: turn in place first, then accelerate
        const alignment = Math.max(0, Math.cos((yawDiff * Math.PI) / 180));
        frame.deltas.move.append([0, 0, this.walkSpeed * this._speedMul * dt * alignment]);
    }
}

const tmpCamera = new Camera();
const tmpv = new Vec3();
const tmpv2 = new Vec3();
// Annotation moves ease in and out, lasting longer the farther the camera travels and turns,
// between these bounds in seconds. Every other transition keeps the quick-start easeOut.
// The curve does most of its travel in the first half and settles through the second, so
// these allow for the settle.
const ANNOTATION_MIN_DURATION = 1.2;
const ANNOTATION_MAX_DURATION = 2.4;
// How hard the annotation move's curve settles: higher gets going sooner and settles longer.
const SETTLE_POWER = 5;
// The highest starting slope carried into a move. The curve stays monotonic up to
// SETTLE_POWER, so this is well inside it.
const MAX_START_SLOPE = 3;
// The view turns a little ahead of the travel, finishing at this share of the move, the way
// a camera operator looks toward where they are going before they arrive.
const TURN_LEAD = 0.8;
// A curve from 0 to 1 over the move that starts at `slope` (progress per unit time: 0 starts
// from rest, 1 at the move's average speed), gets going quickly and settles slowly, like a
// hand-held move rather than an even symmetric ramp. It shapes like a critically damped spring,
// but it arrives at exactly zero speed with no deceleration left, where a spring scaled to land
// in a fixed time still has speed to lose and stops abruptly on a long move.
const settleFrom = (slope) => (x) => 1 - Math.pow(1 - x, SETTLE_POWER) * (1 + (SETTLE_POWER - slope) * x);
// Walk mode is only enabled when the scene's horizontal footprint is large
// enough to walk around in. Vertical extent (Y) is irrelevant — a tall but
// narrow scene isn't walkable. Both X and Z ranges must exceed this
// minimum (in metres); below it walk mode is hidden and the viewer falls
// back to fly as the default first-person mode.
const WALK_MIN_HORIZONTAL_RANGE = 5;
const isWalkAllowed = (bbox, collision) => {
    const { x, z } = bbox.halfExtents;
    return !!collision && x * 2 >= WALK_MIN_HORIZONTAL_RANGE && z * 2 >= WALK_MIN_HORIZONTAL_RANGE;
};
const createCamera = (position, target, fov) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
};
const createFrameCamera = (bbox, fov) => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin((fov / 180) * Math.PI * 0.5);
    return createCamera(new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center), bbox.center, fov);
};
class CameraManager {
    update;
    seek;
    selectAnnotation;
    // Re-seed the active controller from the current camera pose and
    // cancel any in-progress transition lerp. Use after externally
    // mutating `camera` and/or `state.cameraMode` to make the change
    // visible instantly.
    snap;
    // How far the current transition has eased toward its destination, from 0 to 1; 1 when
    // there is none. The annotations time their tooltip to the camera's arrival with it.
    transitionProgress;
    // Attach (or clear) collision after construction. The viewer reveals the scene without
    // waiting for collision data, which can be larger than the splats themselves, so this
    // arrives late. It re-tests whether walk mode is allowed, which gates the walk toggle
    // and the mode the camera falls back to when an animation is interrupted.
    setCollision;
    // holds the camera state
    camera = new Camera();
    constructor(global, bbox, collision = null) {
        const { events, settings, state } = global;
        let walkAllowed = isWalkAllowed(bbox, collision);
        const camera0 = settings.cameras[0]?.initial;
        const defaultFov = camera0?.fov ?? DEFAULT_CAMERA_FOV;
        const frameCamera = createFrameCamera(bbox, defaultFov);
        const resetCamera = camera0
            ? createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov)
            : frameCamera;
        const getAnimTrack = (initial, isObjectExperience) => {
            const { animTracks } = settings;
            // extract the camera animation track from settings
            if (animTracks?.length > 0 && settings.startMode === 'animTrack') {
                // use the first animTrack
                return animTracks[0];
            }
            else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                initial.calcFocusPoint(tmpv);
                return createRotateTrack(initial.position, tmpv, initial.fov);
            }
            // non-object experience: gentle figure-8 motion from inside the scene
            initial.calcFocusPoint(tmpv);
            return createFigure8Track(initial.position, tmpv, initial.fov);
        };
        // object experience starts outside the bounding box
        const isObjectExperience = !bbox.containsPoint(resetCamera.position);
        const animTrack = getAnimTrack(resetCamera, isObjectExperience);
        const controllers = {
            orbit: new OrbitController(),
            fly: new FlyController(),
            walk: new WalkController(),
            anim: animTrack ? new AnimController(animTrack) : null
        };
        controllers.orbit.fov = resetCamera.fov;
        controllers.fly.fov = resetCamera.fov;
        controllers.fly.collision = collision;
        controllers.walk.collision = collision;
        const walkSource = new WalkSource();
        const flySource = new FlySource();
        const sourcesByMode = {
            walk: walkSource,
            fly: flySource
        };
        walkSource.onComplete = flySource.onComplete = () => {
            events.fire('navigateComplete');
        };
        const getController = (cameraMode) => {
            return controllers[cameraMode];
        };
        // set the global animation flag
        state.hasAnimation = !!controllers.anim;
        state.animationDuration = controllers.anim ? controllers.anim.animState.cursor.duration : 0;
        // initialize camera mode and initial camera position
        state.cameraMode = state.hasAnimation ? 'anim' : isObjectExperience ? 'orbit' : walkAllowed ? 'walk' : 'fly';
        this.camera.copy(resetCamera);
        const target = new Camera(this.camera); // the active controller updates this
        const from = new Camera(this.camera); // stores the previous camera state during transition
        const defaultMode = () => (isObjectExperience ? 'orbit' : walkAllowed ? 'walk' : 'fly');
        // null until the first mode change, so the fallback tracks `walkAllowed` if collision
        // attaches before the user has moved
        let fromMode = null;
        // tracks the mode to restore when exiting walk
        let preWalkMode = isObjectExperience ? 'orbit' : 'fly';
        // enter the initial controller
        getController(state.cameraMode).onEnter(this.camera);
        // transition state
        let transitionTimer = 1;
        let transitionDuration = 1;
        let transitionEase = easeOut;
        // annotation moves blend the view angles directly, on their own curve so the turn can
        // lead the travel; the rest blend through the look-at point
        let transitionTurnEase = null;
        let clearOrbitTargetOnTransitionEnd = false;
        // the camera's speed over the last frame, so a new annotation move can carry on from
        // the motion it interrupts rather than restart from rest
        let cameraSpeed = 0;
        const lastPosition = this.camera.position.clone();
        // start a new camera transition from the current pose, over `duration` seconds
        const startTransition = (duration = 1, ease = easeOut, turnEase = null) => {
            from.copy(this.camera);
            transitionTimer = 0;
            transitionDuration = duration;
            transitionEase = ease;
            transitionTurnEase = turnEase;
        };
        this.transitionProgress = () => (transitionTimer < 1 ? transitionEase(transitionTimer) : 1);
        this.setCollision = (value) => {
            controllers.fly.collision = value;
            controllers.walk.collision = value;
            walkAllowed = isWalkAllowed(bbox, value);
        };
        this.snap = () => {
            getController(state.cameraMode).onEnter(this.camera);
            target.copy(this.camera);
            transitionTimer = 1;
            global.app.renderNextFrame = true;
        };
        // application update
        this.update = (deltaTime, frame) => {
            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;
            // update transition timer
            const prevTransitionTimer = transitionTimer;
            transitionTimer = Math.min(1, transitionTimer + deltaTime / transitionDuration);
            const controller = getController(state.cameraMode);
            sourcesByMode[state.cameraMode]?.update(dt, this.camera, frame);
            controller.update(dt, frame, target);
            if (transitionTimer < 1) {
                // lerp away from previous camera during transition
                const t = transitionEase(transitionTimer);
                if (transitionTurnEase) {
                    this.camera.lerpAngles(from, target, t, transitionTurnEase(transitionTimer));
                }
                else {
                    this.camera.lerp(from, target, t);
                }
            }
            else {
                this.camera.copy(target);
            }
            if (deltaTime > 0) {
                cameraSpeed = this.camera.position.distance(lastPosition) / deltaTime;
            }
            lastPosition.copy(this.camera.position);
            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
                // a play-once animation pauses once it reaches the end of the track
                if (!state.animationPaused && controllers.anim.animState.cursor.ended) {
                    state.animationPaused = true;
                }
            }
            if (clearOrbitTargetOnTransitionEnd && prevTransitionTimer < 1 && transitionTimer === 1) {
                clearOrbitTargetOnTransitionEnd = false;
                events.fire('orbitTarget:clear');
            }
        };
        // handle input events
        events.on('inputEvent', (eventName) => {
            switch (eventName) {
                case 'frame':
                    events.fire('orbitTarget:clear');
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(frameCamera);
                    startTransition();
                    break;
                case 'reset':
                    if (state.cameraMode === 'walk') {
                        walkSource.cancel();
                        events.fire('navTarget:clear');
                        startTransition();
                        controllers.walk.resetToSpawn(target);
                    }
                    else if (state.cameraMode === 'fly') {
                        flySource.cancel();
                        startTransition();
                        controllers.fly.resetToSpawn(target);
                    }
                    else {
                        events.fire('orbitTarget:clear');
                        state.cameraMode = 'orbit';
                        controllers.orbit.goto(resetCamera);
                        startTransition();
                    }
                    break;
                case 'playPause':
                    if (state.hasAnimation) {
                        if (state.cameraMode === 'anim') {
                            state.animationPaused = !state.animationPaused;
                        }
                        else {
                            state.cameraMode = 'anim';
                            state.animationPaused = false;
                        }
                    }
                    break;
                case 'requestFirstPerson':
                    // movement input from a non-first-person mode: walk where the scene allows
                    // it, fly otherwise, the same preference as the animation fallback
                    state.cameraMode = walkAllowed ? 'walk' : 'fly';
                    break;
                case 'toggleWalk':
                    if (walkAllowed) {
                        if (state.cameraMode === 'walk') {
                            state.cameraMode = preWalkMode;
                        }
                        else {
                            state.cameraMode = 'walk';
                        }
                    }
                    break;
                case 'exitWalk':
                    if (state.cameraMode === 'walk') {
                        state.cameraMode = preWalkMode;
                    }
                    break;
                case 'cancel':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode ?? defaultMode();
                    }
                    break;
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode ?? defaultMode();
                    }
                    break;
            }
        });
        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            // Host state writes and the walk toggle must remember the same return mode.
            if (value === 'walk') {
                preWalkMode = prev;
            }
            sourcesByMode[prev]?.cancel();
            // snapshot the current pose before any controller mutation
            startTransition();
            target.copy(this.camera);
            fromMode = prev;
            // exit the old controller
            const prevController = getController(prev);
            prevController.onExit(this.camera);
            // enter new controller
            const newController = getController(value);
            newController.onEnter(this.camera);
        });
        // pressing play at (or within a frame of) the end of a play-once animation
        // restarts it from the beginning (a scrub can park just short of the end)
        events.on('animationPaused:changed', (paused) => {
            const animState = controllers.anim?.animState;
            if (!paused && animState) {
                const { cursor } = animState;
                if (cursor.loopMode === 'none' && cursor.duration - cursor.value < 1 / animState.frameRate) {
                    cursor.value = 0;
                }
            }
        });
        this.seek = (time) => {
            // switch to animation camera if we're not already there
            state.cameraMode = 'anim';
            // set time
            controllers.anim.animState.cursor.value = time;
            state.animationTime = controllers.anim.animState.cursor.value;
        };
        // handle user picking in the scene
        events.on('pick', (position) => {
            // switch to orbit camera on pick
            state.cameraMode = 'orbit';
            // construct camera
            tmpCamera.copy(this.camera);
            tmpCamera.look(this.camera.position, position);
            controllers.orbit.goto(tmpCamera);
            startTransition();
            clearOrbitTargetOnTransitionEnd = true;
        });
        this.selectAnnotation = (annotation) => {
            events.fire('orbitTarget:clear');
            // switch to orbit camera on pick
            state.cameraMode = 'orbit';
            const { initial } = annotation.camera;
            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(new Vec3(initial.position), new Vec3(initial.target));
            // orbit at the annotation's depth along the view rather than about the authored
            // target, which is often a hair in front of the lens or far past the subject. The
            // new focus lies on the same view ray, so the pose is unchanged. An annotation
            // behind the camera keeps the authored target
            tmpCamera.calcFocusPoint(tmpv);
            tmpv.sub(tmpCamera.position).normalize();
            const depth = tmpv2
                .set(...annotation.position)
                .sub(tmpCamera.position)
                .dot(tmpv);
            if (depth > 1e-3) {
                tmpCamera.distance = depth;
            }
            // longer for a longer move: travel relative to the scene's size, plus how far the
            // view turns
            const travel = this.camera.position.distance(tmpCamera.position);
            const sceneSize = Math.max(bbox.halfExtents.length(), 1e-3);
            this.camera.calcFocusPoint(tmpv);
            tmpv.sub(this.camera.position).normalize();
            tmpCamera.calcFocusPoint(tmpv2);
            tmpv2.sub(tmpCamera.position).normalize();
            const turn = Math.acos(Math.max(-1, Math.min(1, tmpv.dot(tmpv2)))) / Math.PI;
            const duration = Math.max(ANNOTATION_MIN_DURATION, Math.min(ANNOTATION_MAX_DURATION, ANNOTATION_MIN_DURATION + (0.8 * travel) / sceneSize + 0.6 * turn));
            // start at the camera's current speed, as a share of this move's average speed
            const slope = travel > 1e-6 ? Math.min(MAX_START_SLOPE, (cameraSpeed * duration) / travel) : 0;
            const travelEase = settleFrom(slope);
            const turnEase = settleFrom(slope * TURN_LEAD);
            controllers.orbit.goto(tmpCamera);
            startTransition(duration, travelEase, (x) => turnEase(Math.min(1, x / TURN_LEAD)));
        };
        // tap-to-navigate: start auto-driving the active mode toward a picked position
        events.on('navigateTo', (position, normal, speedMul = 1) => {
            const source = sourcesByMode[state.cameraMode];
            if (source) {
                source.navigateTo(position, speedMul);
                events.fire('navTarget:set', position, normal);
            }
        });
        // cancel any active auto-navigation in the current mode
        events.on('navigateCancel', () => {
            sourcesByMode[state.cameraMode]?.cancel();
            events.fire('navTarget:clear');
        });
        events.on('navigateComplete', () => {
            events.fire('navTarget:clear');
        });
    }
}

// Box-average downsample of a supersampled render. Each output texel averages the
// `uRatio` x `uRatio` block of source texels it covers — true NxN supersampling, which
// keeps thin high-frequency features (splat strings, edges) smooth, unlike a
// bilinear/compositor downscale which aliases them. `uFlipY` flips vertically because
// render targets and readback disagree on row order.
const boxDownsampleGLSL = /* glsl */ `
varying vec2 vUv0;

uniform sampler2D source;
uniform vec2 uSrcSize;
uniform float uRatio;
uniform float uFlipY;

void main(void) {
    int r = int(uRatio);
    vec2 outSize = uSrcSize / uRatio;
    vec2 uv = vUv0;
    if (uFlipY > 0.5) {
        uv.y = 1.0 - uv.y;
    }
    vec2 base = floor(uv * outSize) * uRatio;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 8; y++) {
        if (y >= r) break;
        for (int x = 0; x < 8; x++) {
            if (x >= r) break;
            vec2 texel = base + vec2(float(x) + 0.5, float(y) + 0.5);
            sum += texture2D(source, texel / uSrcSize);
        }
    }
    gl_FragColor = sum / (uRatio * uRatio);
}
`;
// WGSL twin of the box downsample (WebGPU can't compile GLSL, so a custom fullscreen
// shader must supply WGSL too — the built-in fullscreenQuadVS chunk covers the vertex).
const boxDownsampleWGSL = /* wgsl */ `
varying vUv0: vec2f;
var source: texture_2d<f32>;
var sourceSampler: sampler;
uniform uSrcSize: vec2f;
uniform uRatio: f32;
uniform uFlipY: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let r: i32 = i32(uniform.uRatio);
    let outSize: vec2f = uniform.uSrcSize / uniform.uRatio;
    var uv: vec2f = input.vUv0;
    if (uniform.uFlipY > 0.5) {
        uv.y = 1.0 - uv.y;
    }
    let base: vec2f = floor(uv * outSize) * uniform.uRatio;
    var sum: vec4f = vec4f(0.0);
    for (var y: i32 = 0; y < 8; y = y + 1) {
        if (y >= r) { break; }
        for (var x: i32 = 0; x < 8; x = x + 1) {
            if (x >= r) { break; }
            let texel: vec2f = base + vec2f(f32(x) + 0.5, f32(y) + 0.5);
            sum = sum + textureSample(source, sourceSampler, texel / uniform.uSrcSize);
        }
    }
    output.color = sum / (uniform.uRatio * uniform.uRatio);
    return output;
}
`;
// Grabs downsampled snapshots of the viewer entirely on the GPU. The scene is rendered
// (with post effects) into an app-owned render target at `supersample` x the requested
// output size, box-downsampled to the output size, and only that small buffer is read
// back. Rendering into our own target (rather than the backbuffer) means no
// preserveDrawingBuffer, and it works on both WebGL and WebGPU.
class Capture {
    app;
    device;
    camera;
    getCameraFrame;
    shader;
    srcRT = null;
    dstRT = null;
    destroyed = false;
    constructor(app, camera, getCameraFrame) {
        this.app = app;
        this.device = app.graphicsDevice;
        this.camera = camera;
        this.getCameraFrame = getCameraFrame;
        this.shader = ShaderUtils.createShader(this.device, {
            uniqueName: 'captureBoxDownsample',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentGLSL: boxDownsampleGLSL,
            fragmentWGSL: boxDownsampleWGSL
        });
    }
    makeRT(name, width, height, depth) {
        // Plain RGBA8 (RGBA channel order, non-sRGB) so the box shader samples raw bytes
        // and the readback returns raw RGBA — no channel swap (WebGPU backbuffers are
        // often BGRA) and no sRGB decode/encode surprises; we average in the same gamma
        // space sharp did. We only mirror the backbuffer's sRGB *flag* (which the viewer
        // sets true only when post effects are active) — that drives the gamma the render
        // pipeline writes with, so our target receives identical bytes to the screen.
        const dev = this.device;
        const srgb = dev.backBuffer?.isColorBufferSrgb?.(0) ?? false;
        const colorBuffer = new Texture(this.device, {
            name,
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        const rt = new RenderTarget({ name, colorBuffer, depth });
        rt.isColorBufferSrgb = () => srgb;
        return rt;
    }
    /** Release the render targets and shader. The instance is unusable afterwards. */
    destroy() {
        this.destroyed = true;
        for (const target of ['srcRT', 'dstRT']) {
            this[target]?.colorBuffer.destroy();
            this[target]?.destroy();
            this[target] = null;
        }
        this.shader.destroy();
    }
    ensure(target, width, height, depth) {
        const existing = this[target];
        if (existing && existing.width === width && existing.height === height) {
            return existing;
        }
        existing?.colorBuffer.destroy();
        existing?.destroy();
        const rt = this.makeRT(target, width, height, depth);
        this[target] = rt;
        return rt;
    }
    // Point the camera at `renderTarget` and re-target CameraFrame's compose pass. Post
    // effects bind their output inside setupRenderPasses, which only re-runs on a reset,
    // so a plain renderTarget change doesn't take effect — force a reset via layersDirty,
    // otherwise the composited frame keeps going to the old target (reads back black).
    setCameraTarget(renderTarget) {
        this.camera.renderTarget = renderTarget;
        const cameraFrame = this.getCameraFrame();
        if (cameraFrame) {
            const rpc = cameraFrame.renderPassCamera;
            if (rpc) {
                rpc.layersDirty = true;
            }
            cameraFrame.update();
        }
    }
    async grab({ time, width, height, supersample = 2, scrub }) {
        const device = this.device;
        // clamp to the box shaders' 8x8 sample cap: a larger ratio would sum at most 64
        // texels yet still divide by ss*ss, producing an under-exposed (too dark) frame.
        const ss = Math.min(8, Math.max(1, Math.round(supersample)));
        // normalize the output size to positive integers so texture/RT creation and
        // readback don't fail confusingly on 0/negative/non-integer input
        const outW = Math.max(1, Math.round(width));
        const outH = Math.max(1, Math.round(height));
        const srcW = outW * ss;
        const srcH = outH * ss;
        // render the scene (incl. post effects) into our own supersampled target
        const srcRT = this.ensure('srcRT', srcW, srcH, true);
        // Redirect the camera into our offscreen target for the capture, then restore it.
        // window.captureFrame is a global API, so leaving the camera pointed at our target
        // would freeze on-screen rendering after the first call.
        const camera = this.camera;
        const saved = {
            renderTarget: camera.renderTarget,
            aspectRatioMode: camera.aspectRatioMode,
            aspectRatio: camera.aspectRatio,
            horizontalFov: camera.horizontalFov
        };
        try {
            camera.aspectRatioMode = ASPECT_AUTO; // aspect follows the target dims
            camera.horizontalFov = srcW >= srcH;
            this.setCameraTarget(srcRT);
            if (time !== undefined && scrub) {
                scrub(time);
            }
            this.app.renderNextFrame = true;
            await new Promise((resolve) => {
                this.app.once('frameend', () => resolve());
            });
            // box-downsample the supersampled render to the output size
            const dstRT = this.ensure('dstRT', outW, outH, false);
            const { scope } = device;
            scope.resolve('source').setValue(srcRT.colorBuffer);
            scope.resolve('uSrcSize').setValue([srcW, srcH]);
            scope.resolve('uRatio').setValue(ss);
            scope.resolve('uFlipY').setValue(srcRT.flipY ? 0 : 1);
            device.setBlendState(BlendState.NOBLEND);
            drawQuadWithShader(device, dstRT, this.shader);
            const pixels = await dstRT.colorBuffer.read(0, 0, outW, outH, { renderTarget: dstRT, immediate: true });
            const u8 = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
            const chunks = [];
            const chunk = 0x8000;
            for (let i = 0; i < u8.length; i += chunk) {
                chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + chunk)));
            }
            return { width: outW, height: outH, data: btoa(chunks.join('')) };
        }
        finally {
            // A capture still in flight when the viewer is torn down resumes here with the
            // camera, and the app behind it, already destroyed. There is nothing left to put
            // back, and writing to either would reach into released engine state.
            if (!this.destroyed) {
                camera.aspectRatioMode = saved.aspectRatioMode;
                camera.aspectRatio = saved.aspectRatio;
                camera.horizontalFov = saved.horizontalFov;
                this.setCameraTarget(saved.renderTarget);
                this.app.renderNextFrame = true;
            }
        }
    }
}

const captureCameraState = (cm, state) => ({
    position: [cm.camera.position.x, cm.camera.position.y, cm.camera.position.z],
    angles: [cm.camera.angles.x, cm.camera.angles.y, cm.camera.angles.z],
    distance: cm.camera.distance,
    fov: cm.camera.fov,
    mode: state.cameraMode
});
const restoreCameraState = (cm, state, snapshot) => {
    cm.camera.position.set(snapshot.position[0], snapshot.position[1], snapshot.position[2]);
    cm.camera.angles.set(snapshot.angles[0], snapshot.angles[1], snapshot.angles[2]);
    cm.camera.distance = snapshot.distance;
    cm.camera.fov = snapshot.fov;
    // Mode change (if any) fires cameraMode:changed which runs the new
    // controller's onEnter against our just-set pose; snap() then cancels
    // the resulting transition lerp. Same-mode case: snap() re-seeds the
    // active controller in place.
    if (state.cameraMode !== snapshot.mode) {
        state.cameraMode = snapshot.mode;
    }
    cm.snap();
};

/**
 * World picking for splat scenes.
 *
 * Uses a custom `pickPS` / `gsplatPS` patch for a stochastic pick pass, because the stock pick
 * pass encodes splat IDs rather than depth. Each splat fragment survives with probability equal
 * to its opacity, and a MIN blend keeps each pixel's nearest survivor, so a pixel is nearer than
 * a depth with probability equal to the scene's opacity in front of that depth, whatever order
 * the splats draw in. Surfaces are then the depth where that opacity reaches one half: faint haze
 * does not count, while enough of it layered together does.
 */
// Override global picking to output stochastic splat depth instead of meshInstance id.
const pickDepthGlsl = /* glsl */ `
vec4 encodePickOutput(uint id) {
    const vec4 inv = vec4(1.0 / 255.0);
    const uvec4 shifts = uvec4(16, 8, 0, 24);
    uvec4 col = (uvec4(id) >> shifts) & uvec4(0xff);
    return vec4(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    uint pickHash(uint v) {
        v ^= v >> 16u;
        v *= 0x7feb352du;
        v ^= v >> 15u;
        v *= 0x846ca68bu;
        v ^= v >> 16u;
        return v;
    }

    // Four independent trials, one per channel: each keeps the fragment with probability alpha,
    // the splat's opacity at this fragment with its falloff included, writing its depth there,
    // and the far plane where it does not. The splat's seed (see pickSeedVS) and depth, both
    // the same across its quad, hashed with the pixel decorrelate the splats covering one pixel.
    vec4 getSplatPickOutput(float alpha) {
        float normalizedDepth;
        if (camera_params.w > 0.5) {
            normalizedDepth = gl_FragCoord.z;
        } else {
            float linearDepth = 1.0 / gl_FragCoord.w;
            normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
        }

        uvec2 p = uvec2(gl_FragCoord.xy);
        uint h = pickHash(p.x ^ pickHash(p.y ^ pickHash(vPickSeed ^ floatBitsToUint(normalizedDepth))));
        uvec4 trials = uvec4(pickHash(h), pickHash(h ^ 0x9e3779b9u), pickHash(h ^ 0x7f4a7c15u), pickHash(h ^ 0x2545f491u));
        bvec4 keep = lessThan(vec4(trials >> 8u) * (1.0 / 16777216.0), vec4(alpha));
        if (!any(keep)) {
            discard;
        }
        return mix(vec4(1.0), vec4(normalizedDepth), vec4(keep));
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform uint meshInstanceId;

        vec4 getPickOutput() {
            return encodePickOutput(meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    vec4 getPickDepth() {
        float linearDepth;
        if (camera_params.w > 0.5) {
            linearDepth = gl_FragCoord.z;
        } else {
            float viewDist = 1.0 / gl_FragCoord.w;
            linearDepth = (viewDist - camera_params.z) / (camera_params.y - camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;
const pickDepthWgsl = /* wgsl */ `
fn encodePickOutput(id: u32) -> vec4f {
    let inv: vec4f = vec4f(1.0 / 255.0);
    let shifts: vec4u = vec4u(16u, 8u, 0u, 24u);
    let col: vec4u = (vec4u(id) >> shifts) & vec4u(0xffu);
    return vec4f(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn pickHash(value: u32) -> u32 {
        var v = value;
        v ^= v >> 16u;
        v *= 0x7feb352du;
        v ^= v >> 15u;
        v *= 0x846ca68bu;
        v ^= v >> 16u;
        return v;
    }

    // Four independent trials, one per channel: each keeps the fragment with probability alpha,
    // the splat's opacity at this fragment with its falloff included, writing its depth there,
    // and the far plane where it does not. The splat's seed (see pickSeedVS) and depth, both
    // the same across its quad, hashed with the pixel decorrelate the splats covering one pixel.
    fn getSplatPickOutput(alpha: f32) -> vec4f {
        var normalizedDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            normalizedDepth = pcPosition.z;
        } else {
            let linearDepth = 1.0 / pcPosition.w;
            normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }

        let p = vec2u(pcPosition.xy);
        let h = pickHash(p.x ^ pickHash(p.y ^ pickHash(vPickSeed ^ bitcast<u32>(normalizedDepth))));
        let trials = vec4u(pickHash(h), pickHash(h ^ 0x9e3779b9u), pickHash(h ^ 0x7f4a7c15u), pickHash(h ^ 0x2545f491u));
        let keep = vec4f(trials >> vec4u(8u)) * (1.0 / 16777216.0) < vec4f(alpha);
        if (!any(keep)) {
            discard;
        }
        return select(vec4f(1.0), vec4f(normalizedDepth), keep);
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform meshInstanceId: u32;

        fn getPickOutput() -> vec4f {
            return encodePickOutput(uniform.meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn getPickDepth() -> vec4f {
        var linearDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            linearDepth = pcPosition.z;
        } else {
            let viewDist = 1.0 / pcPosition.w;
            linearDepth = (viewDist - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;
const safeChunkReplace = (s, find, repl) => {
    const out = s.replace(find, repl);
    if (out === s) {
        throw new Error('picker: engine gsplat/pick chunk patch failed (engine version mismatch?)');
    }
    return out;
};
const pickPassChunkInjected = (seedVarying) => `#ifdef PICK_PASS
    ${seedVarying}
    #define GSPLAT_PICK_DEPTH
    #include "pickPS"
#endif`;
const seedVaryingGlsl = 'flat varying uint vPickSeed;';
const seedVaryingWgsl = 'varying @interpolate(flat) vPickSeed: u32;';
// pickSeedVS: a per-splat seed for the survival trials, from its projected centre. The depth
// alone would give splats at exactly the same depth the same random values at a pixel, so
// their survivals would be correlated. The centre rather than an index: the cache index of the
// GPU-sort path is the splat's slot in this frame's compacted list, which changes from render
// to render, so repeated picks at one pose would disagree. Only exact duplicates (same centre
// and depth) stay correlated
const pickSeedGlsl = (proj) => `vPickSeed = (floatBitsToUint(${proj}.x) * 0x9e3779b9u) ^ (floatBitsToUint(${proj}.y) * 0x85ebca6bu) ^ (floatBitsToUint(${proj}.w) * 0xc2b2ae35u);`;
const pickSeedWgsl = (proj) => `output.vPickSeed = (bitcast<u32>(${proj}.x) * 0x9e3779b9u) ^ (bitcast<u32>(${proj}.y) * 0x85ebca6bu) ^ (bitcast<u32>(${proj}.w) * 0xc2b2ae35u);`;
const inPickPass = (line) => `\n#ifdef PICK_PASS\n    ${line}\n#endif\n`;
const patchGsplatVSGlsl = (chunk) => safeChunkReplace(safeChunkReplace(chunk, /(varying mediump vec2 gaussianUV;)/, `$1${inPickPass(seedVaryingGlsl)}`), /(gaussianUV = corner\.uv;)/, `$1${inPickPass(pickSeedGlsl('center.proj'))}`);
const patchGsplatVSWgsl = (chunk) => safeChunkReplace(safeChunkReplace(chunk, /(varying gaussianUV: half2;)/, `$1${inPickPass(seedVaryingWgsl)}`), /(output\.gaussianUV = corner\.uv;)/, `$1${inPickPass(pickSeedWgsl('center.proj'))}`);
const patchGsplatHybridVSWgsl = (chunk) => safeChunkReplace(safeChunkReplace(chunk, /(varying gaussianUV: half2;)/, `$1${inPickPass(seedVaryingWgsl)}`), /(output\.gaussianUV = half2\(cornerClipped\);)/, `$1${inPickPass(pickSeedWgsl('proj'))}`);
// Both pick-output calls (with and without unified ids) take the fragment's alpha, which
// `main` computes locally: the varying holds only the splat's peak opacity.
const patchGsplatPickGlsl = (chunk) => {
    return safeChunkReplace(safeChunkReplace(chunk, /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/, pickPassChunkInjected(seedVaryingGlsl)), /pcFragColor0 = (encodePickOutput\(vPickId\)|getPickOutput\(\));/g, 'pcFragColor0 = getSplatPickOutput(alpha);');
};
const patchGsplatPickWgsl = (chunk) => {
    return safeChunkReplace(safeChunkReplace(chunk, /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/, pickPassChunkInjected(seedVaryingWgsl)), /output\.color = (encodePickOutput\(vPickId\)|getPickOutput\(\));/g, 'output.color = getSplatPickOutput(f32(alpha));');
};
/** Per-device original chunk strings + refcount so we can restore after the last Picker releases. */
const pickerShaderPatchState = new WeakMap();
const vec4 = new Vec4();
const viewProjMat = new Mat4();
// the pick pass keeps the nearest surviving depth, so it starts at the far plane
const farColor = new Color(1, 1, 1, 1);
// independent survival trials per pixel, one per channel of the pick render
const PICK_TRIALS = 4;
// A surface's depth is taken over a disc of this radius around each pick pixel (a css pixel,
// see prepareSample): each pixel is one random sample, so a single one says little. Small,
// since it also blurs edges
const SURFACE_RADIUS_PX = 2;
// A surface is where the opacity in front first reaches this. Well under one half: captured
// surfaces seen at a glancing angle, a deck or a floor, can be little more than half opaque,
// and a pick must not pass through them to whatever lies beneath
const SURFACE_OPACITY = 0.3;
const NORMAL_EPSILON$1 = 1e-12;
const NORMAL_DEGENERATE_EPSILON = 1e-20;
// Sampling for the surface-normal estimator runs on a circular footprint of
// fixed *world* radius, projected to pixels at the picked-point's depth.
// Keeping the world area constant means adjacent cursor positions sample
// almost the same world cluster, which stabilises the plane fit. The pixel
// radius is clamped so distant picks still get enough samples and very-close
// picks don't blow the block read.
const NORMAL_SAMPLE_WORLD_RADIUS = 0.2;
const NORMAL_SAMPLE_MIN_PX = 6;
const NORMAL_SAMPLE_MAX_PX = 48;
const NORMAL_RING_FRACTIONS = [0.3, 0.55, 0.8, 1.0];
const NORMAL_OUTLIER_THRESHOLD = 2.5;
const NORMAL_SAMPLE_DIRECTIONS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1]
];
// Shared buffer for half-to-float conversion
const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);
// Convert 16-bit half-float to 32-bit float using bit manipulation.
const half2Float = (h) => {
    const sign = (h & 0x8000) << 16;
    const exponent = (h & 0x7c00) >> 10;
    const mantissa = h & 0x03ff;
    if (exponent === 0) {
        if (mantissa === 0) {
            uint32[0] = sign;
        }
        else {
            let e = -1;
            let m = mantissa;
            do {
                e++;
                m <<= 1;
            } while ((m & 0x0400) === 0);
            uint32[0] = sign | ((127 - 15 - e) << 23) | ((m & 0x03ff) << 13);
        }
    }
    else if (exponent === 31) {
        uint32[0] = sign | 0x7f800000 | (mantissa << 13);
    }
    else {
        uint32[0] = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }
    return float32[0];
};
const registerPickerShaderPatches = (app) => {
    const device = app.graphicsDevice;
    const existing = pickerShaderPatchState.get(device);
    if (existing) {
        existing.refCount++;
        return;
    }
    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');
    const glslPickPS = glslChunks.get('pickPS');
    const glslGsplatPS = glslChunks.get('gsplatPS');
    const wgslPickPS = wgslChunks.get('pickPS');
    const wgslGsplatPS = wgslChunks.get('gsplatPS');
    const glslGsplatVS = glslChunks.get('gsplatVS');
    const wgslGsplatVS = wgslChunks.get('gsplatVS');
    const wgslGsplatHybridVS = wgslChunks.get('gsplatHybridVS');
    // Patch strings before mutating ShaderChunks so engine mismatches leave globals untouched.
    const patchedGlslGsplatPS = patchGsplatPickGlsl(glslGsplatPS);
    const patchedWgslGsplatPS = patchGsplatPickWgsl(wgslGsplatPS);
    const patchedGlslGsplatVS = patchGsplatVSGlsl(glslGsplatVS);
    const patchedWgslGsplatVS = patchGsplatVSWgsl(wgslGsplatVS);
    const patchedWgslGsplatHybridVS = patchGsplatHybridVSWgsl(wgslGsplatHybridVS);
    const state = {
        glslPickPS,
        glslGsplatPS,
        wgslPickPS,
        wgslGsplatPS,
        glslGsplatVS,
        wgslGsplatVS,
        wgslGsplatHybridVS,
        refCount: 1
    };
    pickerShaderPatchState.set(device, state);
    glslChunks.set('pickPS', pickDepthGlsl);
    wgslChunks.set('pickPS', pickDepthWgsl);
    glslChunks.set('gsplatPS', patchedGlslGsplatPS);
    wgslChunks.set('gsplatPS', patchedWgslGsplatPS);
    glslChunks.set('gsplatVS', patchedGlslGsplatVS);
    wgslChunks.set('gsplatVS', patchedWgslGsplatVS);
    wgslChunks.set('gsplatHybridVS', patchedWgslGsplatHybridVS);
};
const unregisterPickerShaderPatches = (app) => {
    const device = app.graphicsDevice;
    const state = pickerShaderPatchState.get(device);
    if (!state) {
        return;
    }
    state.refCount--;
    if (state.refCount > 0) {
        return;
    }
    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');
    glslChunks.set('pickPS', state.glslPickPS);
    glslChunks.set('gsplatPS', state.glslGsplatPS);
    wgslChunks.set('pickPS', state.wgslPickPS);
    wgslChunks.set('gsplatPS', state.wgslGsplatPS);
    glslChunks.set('gsplatVS', state.glslGsplatVS);
    wgslChunks.set('gsplatVS', state.wgslGsplatVS);
    wgslChunks.set('gsplatHybridVS', state.wgslGsplatHybridVS);
    pickerShaderPatchState.delete(device);
};
const createPickCameraSnapshot = () => ({
    position: new Vec3(),
    viewMatrix: new Mat4(),
    projectionMatrix: new Mat4(),
    nearClip: 0,
    farClip: 0,
    projection: 0
});
const captureCameraSnapshot = (camera, out) => {
    const cam = camera.camera;
    out.position.copy(camera.getPosition());
    out.viewMatrix.copy(cam.viewMatrix);
    out.projectionMatrix.copy(cam.projectionMatrix);
    out.nearClip = cam.nearClip;
    out.farClip = cam.farClip;
    out.projection = cam.projection;
};
const getWorldPoint = (camera, x, y, width, height, normalizedDepth, out) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }
    const { farClip: far, nearClip: near } = camera;
    const ndcDepth = camera.projection === PROJECTION_ORTHOGRAPHIC
        ? normalizedDepth
        : (far * normalizedDepth) / (normalizedDepth * (far - near) + near);
    viewProjMat.mul2(camera.projectionMatrix, camera.viewMatrix).invert();
    vec4.set((x / width) * 2 - 1, (1 - y / height) * 2 - 1, ndcDepth * 2 - 1, 1);
    viewProjMat.transformVec4(vec4, vec4);
    if (!Number.isFinite(vec4.w) || Math.abs(vec4.w) < 1e-8) {
        return null;
    }
    vec4.mulScalar(1 / vec4.w);
    if (!Number.isFinite(vec4.x) || !Number.isFinite(vec4.y) || !Number.isFinite(vec4.z)) {
        return null;
    }
    return (out ?? new Vec3()).set(vec4.x, vec4.y, vec4.z);
};
const setCameraFacingNormal = (cameraPosition, position, normal) => {
    normal.sub2(cameraPosition, position);
    const len = normal.length();
    if (len > 1e-6) {
        normal.mulScalar(1 / len);
    }
    else {
        normal.set(0, 1, 0);
    }
    return normal;
};
// Project a world-space radius around `pos` to its on-screen pixel radius for
// the given camera. Uses the projection matrix's [1][1] entry (= 1/tan(fov/2)
// for perspective, = 1/orthoHeight for orthographic) so we don't need fov or
// orthoHeight on the snapshot.
const worldRadiusToPixelRadius = (cam, pos, canvasHeight, worldRadius) => {
    const projY = cam.projectionMatrix.data[5];
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return (worldRadius * projY * canvasHeight) / 2;
    }
    const dx = pos.x - cam.position.x;
    const dy = pos.y - cam.position.y;
    const dz = pos.z - cam.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-6)
        return Infinity;
    return (worldRadius * projY * canvasHeight) / (2 * distance);
};
// Single least-squares plane fit through a cluster of 3D points. The normal
// is the eigenvector of the smallest eigenvalue of the points' 3x3 covariance
// matrix, computed in closed form (analytic eigendecomposition for 3x3
// symmetric, Smith 1961). Returns null on degenerate input.
const fitPlaneOnce = (points) => {
    const n = points.length;
    if (n < 3)
        return null;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += points[i].x;
        cy += points[i].y;
        cz += points[i].z;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (let i = 0; i < n; i++) {
        const dx = points[i].x - cx;
        const dy = points[i].y - cy;
        const dz = points[i].z - cz;
        cxx += dx * dx;
        cxy += dx * dy;
        cxz += dx * dz;
        cyy += dy * dy;
        cyz += dy * dz;
        czz += dz * dz;
    }
    const q = (cxx + cyy + czz) / 3;
    const a = cxx - q, b = cyy - q, c = czz - q;
    const p2 = a * a + b * b + c * c + 2 * (cxy * cxy + cxz * cxz + cyz * cyz);
    if (p2 < NORMAL_DEGENERATE_EPSILON)
        return null;
    const p = Math.sqrt(p2 / 6);
    const inv = 1 / p;
    const Bxx = a * inv, Bxy = cxy * inv, Bxz = cxz * inv;
    const Byy = b * inv, Byz = cyz * inv, Bzz = c * inv;
    const detB = Bxx * (Byy * Bzz - Byz * Byz) - Bxy * (Bxy * Bzz - Byz * Bxz) + Bxz * (Bxy * Byz - Byy * Bxz);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const lambdaMin = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    const Mxx = cxx - lambdaMin, Myy = cyy - lambdaMin, Mzz = czz - lambdaMin;
    const v1x = cxy * cyz - cxz * Myy;
    const v1y = cxz * cxy - Mxx * cyz;
    const v1z = Mxx * Myy - cxy * cxy;
    const v2x = cxy * Mzz - cxz * cyz;
    const v2y = cxz * cxz - Mxx * Mzz;
    const v2z = Mxx * cyz - cxy * cxz;
    const v3x = Myy * Mzz - cyz * cyz;
    const v3y = cyz * cxz - cxy * Mzz;
    const v3z = cxy * cyz - Myy * cxz;
    const l1 = v1x * v1x + v1y * v1y + v1z * v1z;
    const l2 = v2x * v2x + v2y * v2y + v2z * v2z;
    const l3 = v3x * v3x + v3y * v3y + v3z * v3z;
    let vx, vy, vz, lSq;
    if (l1 >= l2 && l1 >= l3) {
        vx = v1x;
        vy = v1y;
        vz = v1z;
        lSq = l1;
    }
    else if (l2 >= l3) {
        vx = v2x;
        vy = v2y;
        vz = v2z;
        lSq = l2;
    }
    else {
        vx = v3x;
        vy = v3y;
        vz = v3z;
        lSq = l3;
    }
    if (lSq < NORMAL_EPSILON$1)
        return null;
    const invLen = 1 / Math.sqrt(lSq);
    return { cx, cy, cz, vx: vx * invLen, vy: vy * invLen, vz: vz * invLen };
};
// Two-pass plane fit: first pass on all points, then drop points whose
// distance from the fitted plane exceeds NORMAL_OUTLIER_THRESHOLD * the mean
// residual, refit on the inliers. Sign-flips the result toward toCamera so
// the cursor's tangent basis stays consistent. Returns false on degenerate
// input (fewer than 3 points, collinear/coincident samples).
const fitPlaneNormal = (points, toCamera, outNormal) => {
    const first = fitPlaneOnce(points);
    if (!first)
        return false;
    let residualSum = 0;
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        residualSum += Math.abs(dx * first.vx + dy * first.vy + dz * first.vz);
    }
    const threshold = (residualSum / points.length) * NORMAL_OUTLIER_THRESHOLD;
    const inliers = [];
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        if (Math.abs(dx * first.vx + dy * first.vy + dz * first.vz) <= threshold) {
            inliers.push(points[i]);
        }
    }
    let result = first;
    if (inliers.length >= 3 && inliers.length < points.length) {
        const refined = fitPlaneOnce(inliers);
        if (refined)
            result = refined;
    }
    let { vx, vy, vz } = result;
    if (vx * toCamera.x + vy * toCamera.y + vz * toCamera.z < 0) {
        vx = -vx;
        vy = -vy;
        vz = -vz;
    }
    outNormal.set(vx, vy, vz);
    return true;
};
// The surface at a pixel: the SURFACE_OPACITY quantile of the nearest survivors over a small
// disc, which is the depth where the opacity in front reaches that. Null where it never does.
const surfaceDepth = (depthAt, x, y) => {
    const samples = [];
    for (let dy = -SURFACE_RADIUS_PX; dy <= SURFACE_RADIUS_PX; dy++) {
        for (let dx = -SURFACE_RADIUS_PX; dx <= SURFACE_RADIUS_PX; dx++) {
            if (dx * dx + dy * dy > SURFACE_RADIUS_PX * SURFACE_RADIUS_PX)
                continue;
            for (let trial = 0; trial < PICK_TRIALS; trial++) {
                const depth = depthAt(x + dx, y + dy, trial);
                if (depth !== null)
                    samples.push(depth);
            }
        }
    }
    if (samples.length === 0) {
        return null;
    }
    samples.sort((a, b) => a - b);
    const depth = samples[Math.max(0, Math.ceil(samples.length * SURFACE_OPACITY) - 1)];
    return Number.isFinite(depth) && depth < 1 ? depth : null;
};
// The surface under a pixel and its normal, fitted through surface points on rings around it.
// `depthAt` must cover NORMAL_SAMPLE_MAX_PX + SURFACE_RADIUS_PX around the pixel.
const estimateSurface = (depthAt, pickCamera, width, height, screenX, screenY) => {
    const surfacePoint = (px, py) => {
        const depth = surfaceDepth(depthAt, px, py);
        return depth === null ? null : getWorldPoint(pickCamera, px, py, width, height, depth);
    };
    const position = surfacePoint(screenX, screenY);
    if (!position) {
        return null;
    }
    const samplePixel = (px, py) => {
        if (px < 0 || px >= width || py < 0 || py >= height) {
            return null;
        }
        return surfacePoint(px, py);
    };
    // Pixel radius corresponding to a fixed world radius at the
    // picked-point's depth. Clamped so distant picks still sample
    // enough pixels and very-close picks stay inside the block read.
    const pixelRadius = Math.max(NORMAL_SAMPLE_MIN_PX, Math.min(NORMAL_SAMPLE_MAX_PX, worldRadiusToPixelRadius(pickCamera, position, height, NORMAL_SAMPLE_WORLD_RADIUS)));
    const ringPixelRadii = NORMAL_RING_FRACTIONS.map((f) => Math.max(1, Math.round(f * pixelRadius)));
    const sampleRings = ringPixelRadii.map((radius) => {
        return NORMAL_SAMPLE_DIRECTIONS.map(([dx, dy]) => {
            return samplePixel(screenX + dx * radius, screenY + dy * radius);
        });
    });
    const toCamera = setCameraFacingNormal(pickCamera.position, position, new Vec3());
    // Collect every valid 3D sample: the picked position plus all ring
    // samples that didn't fall off-screen or find no surface.
    const fitPoints = [position];
    for (let i = 0; i < sampleRings.length; i++) {
        const ring = sampleRings[i];
        for (let j = 0; j < ring.length; j++) {
            const pt = ring[j];
            if (pt)
                fitPoints.push(pt);
        }
    }
    const normal = new Vec3();
    if (!fitPlaneNormal(fitPoints, toCamera, normal)) {
        normal.copy(toCamera);
    }
    return {
        position,
        normal
    };
};
// The share of samples over a disc of `r` pixels whose nearest survivor is nearer than the view
// depth `depth`; null where the disc has no samples. `depthAt` must cover the disc.
const opacityInFront = (depthAt, pickCamera, screenX, screenY, r, depth) => {
    const threshold = (depth - pickCamera.nearClip) / (pickCamera.farClip - pickCamera.nearClip);
    let total = 0;
    let inFront = 0;
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r)
                continue;
            for (let trial = 0; trial < PICK_TRIALS; trial++) {
                const nearest = depthAt(screenX + dx, screenY + dy, trial);
                if (nearest === null)
                    continue;
                total++;
                if (nearest < threshold)
                    inFront++;
            }
        }
    }
    return total > 0 ? inFront / total : null;
};
// One pick pixel per css pixel, never more than the backbuffer has: picking then behaves the
// same in performance mode and at any device pixel ratio, since the pixel sizes above are css
// pixels, and a high-density display does not multiply the pass's cost. Null before the device
// or the canvas has been sized.
const pickTargetSize = (graphicsDevice) => {
    const canvas = graphicsDevice.canvas;
    const width = Math.min(Math.floor(graphicsDevice.width), Math.round(canvas.clientWidth));
    const height = Math.min(Math.floor(graphicsDevice.height), Math.round(canvas.clientHeight));
    return width > 0 && height > 0 ? { width, height } : null;
};
const clampPixel = (v, size) => Math.min(size - 1, Math.max(0, Math.floor(v * size)));
// Picks run one at a time, since they share one render. `fallback` is the result for a pick
// that release overtakes: one queued behind another pick, or one whose read-back is cut short
// as the device goes.
class PickQueue {
    released = false;
    queue = Promise.resolve();
    run(operation, fallback) {
        const guarded = () => {
            if (this.released) {
                return Promise.resolve(fallback);
            }
            return operation().catch((error) => {
                if (this.released) {
                    return fallback;
                }
                throw error;
            });
        };
        const result = this.queue.then(guarded, guarded);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
class Picker {
    pick;
    pickSurface;
    /**
     * Estimate how opaque the scene is in front of several points, for testing many at once
     * (the annotation occlusion test): the share of the pick render's pixels, over a disc of
     * `radius` around each point, whose nearest survivor is nearer than the point's `depth`.
     * Coordinates and radius are normalised like `pick`'s (the radius to the height); `depth`
     * is the view depth to test against. Each result is 0 (nothing in front) to 1 (opaque), or
     * null where the disc is off the render.
     */
    pickVisibility;
    /**
     * Bring the pick render up to date for the current camera and return its texture, for a view
     * that reads it on the GPU (the debug panel's pick depth), with a count of the renders so
     * far, which changes whenever the texture does. Each channel is one trial's nearest
     * surviving normalised depth, 1 where nothing survived. Null before the device is sized or
     * after release. Call it between frames, as the picks do: a pick pass rendered during a
     * frame (in `prerender`, say) can come out empty.
     */
    renderView;
    release;
    constructor(app, camera) {
        const { graphicsDevice } = app;
        let pickBuffer;
        let pickTarget;
        let pickPass;
        let chunksPatched = false;
        const queue = new PickQueue();
        let cacheValid = false;
        let renders = 0;
        let cacheWidth = 0;
        let cacheHeight = 0;
        const cacheCamera = createPickCameraSnapshot();
        const initPickTarget = (width, height) => {
            pickBuffer = new Texture(graphicsDevice, {
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                name: 'picker-stochastic'
            });
            pickTarget = new RenderTarget({
                colorBuffer: pickBuffer,
                depth: false // not needed: the blend keeps the nearest depth
            });
            pickPass = new RenderPassPicker(graphicsDevice, app.renderer);
            // the nearest surviving depth wins, whatever order the splats draw in
            pickPass.blendState = new BlendState(true, BLENDEQUATION_MIN, BLENDMODE_ONE, BLENDMODE_ONE, BLENDEQUATION_MIN, BLENDMODE_ONE, BLENDMODE_ONE);
        };
        const updateCache = (width, height) => {
            captureCameraSnapshot(camera, cacheCamera);
            cacheWidth = width;
            cacheHeight = height;
        };
        const cameraMatches = (width, height) => {
            const cam = camera.camera;
            return (cacheValid &&
                cacheWidth === width &&
                cacheHeight === height &&
                cacheCamera.viewMatrix.equals(cam.viewMatrix) &&
                cacheCamera.projectionMatrix.equals(cam.projectionMatrix) &&
                cacheCamera.nearClip === cam.nearClip &&
                cacheCamera.farClip === cam.farClip &&
                cacheCamera.projection === cam.projection);
        };
        const getCacheCameraSnapshot = () => {
            const snapshot = createPickCameraSnapshot();
            snapshot.position.copy(cacheCamera.position);
            snapshot.viewMatrix.copy(cacheCamera.viewMatrix);
            snapshot.projectionMatrix.copy(cacheCamera.projectionMatrix);
            snapshot.nearClip = cacheCamera.nearClip;
            snapshot.farClip = cacheCamera.farClip;
            snapshot.projection = cacheCamera.projection;
            return snapshot;
        };
        // Read the pick render around a pixel, `margin` pixels each way, clamped to the render.
        const readAround = async (screenX, screenY, margin, width, height) => {
            const blockX = Math.max(0, screenX - margin);
            const blockY = Math.max(0, screenY - margin);
            const blockWidth = Math.min(width - 1, screenX + margin) - blockX + 1;
            const blockHeight = Math.min(height - 1, screenY + margin) - blockY + 1;
            const texY = graphicsDevice.isWebGL2 ? pickTarget.height - blockY - blockHeight : blockY;
            const pixels = (await pickBuffer.read(blockX, texY, blockWidth, blockHeight, {
                renderTarget: pickTarget,
                immediate: true
            }));
            return (x, y, trial) => {
                const localX = x - blockX;
                const localY = y - blockY;
                if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                    return null;
                }
                const row = graphicsDevice.isWebGL2 ? blockHeight - localY - 1 : localY;
                return half2Float(pixels[(row * blockWidth + localX) * 4 + trial]);
            };
        };
        const ensureRendered = (width, height, worldLayer) => {
            if (cameraMatches(width, height)) {
                return;
            }
            // No gsplat ids: the pass outputs depth, not ids, and switching `enableIds` changes the
            // work buffer's format, which rebuilds the whole work buffer on the next frame
            if (!chunksPatched) {
                registerPickerShaderPatches(app);
                chunksPatched = true;
            }
            if (!pickPass) {
                initPickTarget(width, height);
            }
            else if (cacheWidth !== width || cacheHeight !== height) {
                cacheValid = false;
                pickTarget.resize(width, height);
            }
            pickPass.init(pickTarget);
            pickPass.setClearColor(farColor);
            pickPass.update(camera.camera, app.scene, [worldLayer], new Map(), false);
            pickPass.render();
            updateCache(width, height);
            cacheValid = true;
            renders++;
        };
        const prepareSample = (x, y) => {
            if (queue.released) {
                return null;
            }
            const size = pickTargetSize(graphicsDevice);
            if (!size) {
                return null;
            }
            const { width, height } = size;
            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }
            const screenX = clampPixel(x, width);
            const screenY = clampPixel(y, height);
            ensureRendered(width, height, worldLayer);
            const pickCamera = getCacheCameraSnapshot();
            return { width, height, screenX, screenY, pickCamera };
        };
        const pick = async (x, y) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, pickCamera } = sample;
            const depthAt = await readAround(screenX, screenY, SURFACE_RADIUS_PX, width, height);
            const depth = surfaceDepth(depthAt, screenX, screenY);
            return depth === null ? null : getWorldPoint(pickCamera, screenX, screenY, width, height, depth);
        };
        const pickSurface = async (x, y) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, pickCamera } = sample;
            // Single block read serves both the depth (center pixel) and the normal samples.
            // Sized to the maximum possible ring pixel-radius, plus the surface disc around each
            // sample, so the dynamic ring offsets always lie inside the buffer we read.
            const depthAt = await readAround(screenX, screenY, NORMAL_SAMPLE_MAX_PX + SURFACE_RADIUS_PX, width, height);
            return estimateSurface(depthAt, pickCamera, width, height, screenX, screenY);
        };
        const pickVisibility = async (points, radius) => {
            if (points.length === 0) {
                return [];
            }
            // every point renders from the same cached pass, since the camera cannot change
            // between these synchronous calls; the reads then run in parallel
            return Promise.all(points.map(async ({ x, y, depth }) => {
                const sample = prepareSample(x, y);
                if (!sample) {
                    return null;
                }
                const { width, height, screenX, screenY, pickCamera } = sample;
                const r = Math.max(1, Math.round(radius * height));
                const depthAt = await readAround(screenX, screenY, r, width, height);
                return opacityInFront(depthAt, pickCamera, screenX, screenY, r, depth);
            }));
        };
        this.pick = (x, y) => queue.run(() => pick(x, y), null);
        this.pickSurface = (x, y) => queue.run(() => pickSurface(x, y), null);
        this.pickVisibility = (points, radius) => queue.run(() => pickVisibility(points, radius), points.map(() => null));
        this.renderView = () => (prepareSample(0, 0) ? { texture: pickBuffer, renders } : null);
        // The scene can change under a still camera, which the camera-based cache cannot see:
        // finer detail streams in after the reveal and after every move. The engine reports each
        // frame whether all the detail it wants is resident, so the cached render is stale on
        // every frame it is not, and once more when it becomes so. Nothing re-renders until a
        // pick needs it.
        const gsplatSystem = app.systems.gsplat;
        let contentReady = false;
        const onFrameReady = (frameCamera, _layer, ready) => {
            if (frameCamera !== camera.camera)
                return;
            if (!ready || !contentReady) {
                cacheValid = false;
            }
            contentReady = ready;
        };
        gsplatSystem.on('frame:ready', onFrameReady);
        this.release = () => {
            queue.released = true;
            gsplatSystem.off('frame:ready', onFrameReady);
            if (chunksPatched) {
                unregisterPickerShaderPatches(app);
                chunksPatched = false;
            }
            pickPass?.destroy();
            pickTarget?.destroy();
            pickBuffer?.destroy();
            cacheValid = false;
        };
    }
}

// the pick render's samples in a surface disc, and how many of the nearest the quantile needs
let discPixels = 0;
for (let dy = -SURFACE_RADIUS_PX; dy <= SURFACE_RADIUS_PX; dy++) {
    for (let dx = -SURFACE_RADIUS_PX; dx <= SURFACE_RADIUS_PX; dx++) {
        if (dx * dx + dy * dy <= SURFACE_RADIUS_PX * SURFACE_RADIUS_PX)
            discPixels++;
    }
}
const NEAREST = Math.ceil(discPixels * PICK_TRIALS * SURFACE_OPACITY);
const R = SURFACE_RADIUS_PX;
// Resolve: each pixel's surface depth, the SURFACE_OPACITY quantile of the pick render's
// nearest survivors over the same disc as `Picker.pickSurface`, as linear view depth; 0 where
// no surface is found
const resolveGlsl = /* glsl */ `
uniform highp sampler2D pickDepth;
uniform vec2 pickRange;
uniform float surfaceOpacity;
void main(void) {
    ivec2 size = textureSize(pickDepth, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    float nearest[${NEAREST}];
    for (int i = 0; i < ${NEAREST}; i++) nearest[i] = 2.0;
    int n = 0;
    for (int dy = -${R}; dy <= ${R}; dy++) {
        for (int dx = -${R}; dx <= ${R}; dx++) {
            ivec2 q = p + ivec2(dx, dy);
            if (dx * dx + dy * dy > ${R * R} || any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) continue;
            vec4 trials = texelFetch(pickDepth, q, 0);
            for (int c = 0; c < ${PICK_TRIALS}; c++) {
                float v = trials[c];
                n++;
                if (v < nearest[${NEAREST - 1}]) {
                    int i = ${NEAREST - 1};
                    while (i > 0 && nearest[i - 1] > v) {
                        nearest[i] = nearest[i - 1];
                        i--;
                    }
                    nearest[i] = v;
                }
            }
        }
    }
    float depth = nearest[clamp(int(ceil(float(n) * surfaceOpacity)) - 1, 0, ${NEAREST - 1})];
    float z = depth < 1.0 ? pickRange.x + depth * (pickRange.y - pickRange.x) : 0.0;
    gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}
`;
const resolveWgsl = /* wgsl */ `
var pickDepth: texture_2d<uff>;
uniform pickRange: vec2f;
uniform surfaceOpacity: f32;
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let size = vec2i(textureDimensions(pickDepth, 0));
    let p = vec2i(pcPosition.xy);
    var nearest: array<f32, ${NEAREST}>;
    for (var i = 0; i < ${NEAREST}; i++) {
        nearest[i] = 2.0;
    }
    var n = 0;
    for (var dy = -${R}; dy <= ${R}; dy++) {
        for (var dx = -${R}; dx <= ${R}; dx++) {
            let q = p + vec2i(dx, dy);
            if (dx * dx + dy * dy > ${R * R} || any(q < vec2i(0)) || any(q >= size)) {
                continue;
            }
            let trials = textureLoad(pickDepth, q, 0);
            for (var c = 0; c < ${PICK_TRIALS}; c++) {
                let v = trials[c];
                n++;
                if (v < nearest[${NEAREST - 1}]) {
                    var i = ${NEAREST - 1};
                    loop {
                        if (i == 0 || nearest[i - 1] <= v) {
                            break;
                        }
                        nearest[i] = nearest[i - 1];
                        i--;
                    }
                    nearest[i] = v;
                }
            }
        }
    }
    let depth = nearest[clamp(i32(ceil(f32(n) * uniform.surfaceOpacity)) - 1, 0, ${NEAREST - 1})];
    let z = select(0.0, uniform.pickRange.x + depth * (uniform.pickRange.y - uniform.pickRange.x), depth < 1.0);
    output.color = vec4f(z, 0.0, 0.0, 1.0);
    return output;
}
`;
// Turbo colour map, polynomial approximation
const turboGlsl = /* glsl */ `
vec3 turbo(float x) {
    const vec4 r4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 g4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 b4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 r2 = vec2(-152.94239396, 59.28637943);
    const vec2 g2 = vec2(4.27729857, 2.82956604);
    const vec2 b2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, r4) + dot(v2, r2), dot(v4, g4) + dot(v2, g2), dot(v4, b4) + dot(v2, b2));
}
`;
const turboWgsl = /* wgsl */ `
fn turbo(x: f32) -> vec3f {
    let r4 = vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    let g4 = vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    let b4 = vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    let r2 = vec2f(-152.94239396, 59.28637943);
    let g2 = vec2f(4.27729857, 2.82956604);
    let b2 = vec2f(-89.90310912, 27.34824973);
    let v4 = vec4f(1.0, x, x * x, x * x * x);
    let v2 = v4.zw * v4.z;
    return vec3f(dot(v4, r4) + dot(v2, r2), dot(v4, g4) + dot(v2, g2), dot(v4, b4) + dot(v2, b2));
}
`;
// Colour: the resolved depth at this pixel, looked up at the pick render's css resolution from
// the target being drawn, whose size the renderer supplies as viewport_size: the backbuffer, or
// captureFrame's supersampled offscreen target
const colourGlsl = /* glsl */ `
uniform highp sampler2D surfaceDepth;
uniform vec4 viewport_size;
${turboGlsl}
void main(void) {
    ivec2 size = textureSize(surfaceDepth, 0);
    float z = texelFetch(surfaceDepth, ivec2(gl_FragCoord.xy * vec2(size) * viewport_size.zw), 0).r;
    gl_FragColor = z > 0.0 ? vec4(turbo(fract(log2(z))), 1.0) : vec4(0.6, 0.0, 0.6, 1.0);
}
`;
const colourWgsl = /* wgsl */ `
var surfaceDepth: texture_2d<uff>;
uniform viewport_size: vec4f;
${turboWgsl}
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let size = vec2f(textureDimensions(surfaceDepth, 0));
    let z = textureLoad(surfaceDepth, vec2i(pcPosition.xy * size * uniform.viewport_size.zw), 0).r;
    output.color = select(vec4f(0.6, 0.0, 0.6, 1.0), vec4f(turbo(fract(log2(z))), 1.0), z > 0.0);
    return output;
}
`;
/**
 * Debug view of the depth the picker resolves: every pixel shows the surface a navigation pick
 * there would find, the same SURFACE_OPACITY quantile of the pick render's nearest survivors
 * over the same disc, so no clicking around. Two passes: the depth is resolved once per pick
 * pixel, then coloured at the size of the target drawn. The colour runs through the map once
 * per doubling of distance, so noise and steps show at any scale; magenta is where no surface
 * is found.
 *
 * The pick and the resolve run after each frame, as a pick pass rendered during a frame can
 * come out empty, and only when the pick render changed (the camera moved, or new detail
 * landed), which then asks for a frame to show it: the view trails the camera by a frame while
 * it moves, and costs a pick pass per frame then. Offscreen renders (captureFrame) do not show
 * it, as it follows the on-screen camera, whose framing a capture need not share.
 */
class PickDepthOverlay {
    app;
    camera;
    picker;
    resolveShader;
    material = new ShaderMaterial();
    quad;
    depthTarget = null;
    onFrameEnd = () => this.resolve();
    onPrerender = () => this.draw();
    // the pick render the resolved depth came from, by the picker's render count
    resolvedRenders = -1;
    _enabled = false;
    constructor(app, camera, picker) {
        this.app = app;
        this.camera = camera;
        this.picker = picker;
        this.resolveShader = ShaderUtils.createShader(app.graphicsDevice, {
            uniqueName: 'PickDepthResolve',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentGLSL: resolveGlsl,
            fragmentWGSL: resolveWgsl
        });
        const material = this.material;
        material.cull = CULLFACE_NONE;
        material.blendType = BLEND_NONE;
        material.depthTest = false;
        material.depthWrite = false;
        material.shaderDesc = {
            uniqueName: 'PickDepthColour',
            vertexGLSL: /* glsl */ `
                attribute vec2 vertex_position;
                uniform mat4 matrix_model;
                void main(void) {
                    gl_Position = matrix_model * vec4(vertex_position, 0, 1);
                }
            `,
            vertexWGSL: /* wgsl */ `
                attribute vertex_position: vec2f;
                uniform matrix_model: mat4x4f;
                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
                    return output;
                }
            `,
            fragmentGLSL: colourGlsl,
            fragmentWGSL: colourWgsl,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
        material.update();
        // fullscreen quad in the default draw layer, shown on frames draw() allows; the node is
        // outside the hierarchy, so its fixed transform is synced here once
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]);
        mesh.update(PRIMITIVE_TRISTRIP);
        const node = new GraphNode('PickDepthColour');
        node.setLocalScale(2, -2, 1);
        node.getWorldTransform();
        this.quad = new MeshInstance(mesh, material, node);
        this.quad.cull = false;
        this.quad.castShadow = false;
        this.quad.pick = false;
        this.quad.visible = false;
        app.scene.defaultDrawLayer.addMeshInstances([this.quad], true);
    }
    get enabled() {
        return this._enabled;
    }
    set enabled(value) {
        if (value === this._enabled)
            return;
        this._enabled = value;
        if (value) {
            this.app.on('frameend', this.onFrameEnd);
            this.app.on('prerender', this.onPrerender);
        }
        else {
            this.app.off('frameend', this.onFrameEnd);
            this.app.off('prerender', this.onPrerender);
            this.resolvedRenders = -1;
            this.quad.visible = false;
        }
        this.app.renderNextFrame = true;
    }
    ensureDepthTarget(width, height) {
        const target = this.depthTarget;
        if (target && target.width === width && target.height === height) {
            return target;
        }
        target?.colorBuffer.destroy();
        target?.destroy();
        const device = this.app.graphicsDevice;
        const colorBuffer = new Texture(device, {
            name: 'pick-depth-resolved',
            width,
            height,
            format: device.textureFloatRenderable ? PIXELFORMAT_R32F : PIXELFORMAT_R16F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.depthTarget = new RenderTarget({ name: 'pick-depth-resolved', colorBuffer, depth: false });
        return this.depthTarget;
    }
    resolve() {
        if (this.camera.camera.renderTarget)
            return;
        const view = this.picker.renderView();
        if (!view || view.renders === this.resolvedRenders)
            return;
        this.resolvedRenders = view.renders;
        const device = this.app.graphicsDevice;
        const cam = this.camera.camera;
        const target = this.ensureDepthTarget(view.texture.width, view.texture.height);
        device.scope.resolve('pickDepth').setValue(view.texture);
        device.scope.resolve('pickRange').setValue([cam.nearClip, cam.farClip]);
        device.scope.resolve('surfaceOpacity').setValue(SURFACE_OPACITY);
        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, target, this.resolveShader);
        // show it
        this.app.renderNextFrame = true;
    }
    draw() {
        this.quad.visible = false;
        // nothing resolved yet: the first frame's end resolves, and asks for the next
        if (!this.depthTarget || this.resolvedRenders < 0 || this.camera.camera.renderTarget)
            return;
        this.material.setParameter('surfaceDepth', this.depthTarget.colorBuffer);
        this.quad.visible = true;
    }
    destroy() {
        this.enabled = false;
        this.app.scene.defaultDrawLayer.removeMeshInstances([this.quad], true);
        this.quad.destroy();
        this.material.destroy();
        this.resolveShader.destroy();
        this.depthTarget?.colorBuffer.destroy();
        this.depthTarget?.destroy();
        this.depthTarget = null;
    }
}

// Developer / debug panel. Hidden by default; surfaced via `?debug` URL
// param or Ctrl+Shift+D keyboard shortcut. DOM and styles are injected
// lazily on first show so there's no footprint on production URLs.
const STYLE_ID = 'sse-debug-panel-style';
const PANEL_CLASS = 'sse-debug-panel';
const STYLES = `
.${PANEL_CLASS} {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    left: max(8px, env(safe-area-inset-left));
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.7);
    color: #eee;
    font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    pointer-events: auto;
    user-select: none;
    min-width: 220px;
}
.${PANEL_CLASS} .sse-debug-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    white-space: nowrap;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-label {
    color: #888;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value {
    color: #eee;
    font-variant-numeric: tabular-nums;
    cursor: text;
    padding: 0 4px;
    margin: 0 -4px;
    border-radius: 2px;
    transition: background-color 0.15s ease;
    outline: none;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value:hover {
    background: rgba(255, 255, 255, 0.08);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value:focus {
    background: rgba(255, 255, 255, 0.12);
    box-shadow: inset 0 0 0 1px rgba(120, 180, 255, 0.45);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value.sse-flash-ok {
    background: rgba(120, 220, 140, 0.35);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value.sse-flash-bad {
    background: rgba(220, 100, 100, 0.45);
}
.${PANEL_CLASS} .sse-debug-buttons {
    display: flex;
    gap: 6px;
    margin-top: 6px;
}
.${PANEL_CLASS} button {
    flex: 1;
    background: rgba(255, 255, 255, 0.08);
    color: #eee;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    padding: 4px 8px;
    font: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
}
.${PANEL_CLASS} button:hover {
    background: rgba(255, 255, 255, 0.16);
}
.${PANEL_CLASS} button.sse-flash {
    background: rgba(120, 220, 140, 0.35);
}
.${PANEL_CLASS} button.sse-flash-bad {
    background: rgba(220, 100, 100, 0.45);
}
.${PANEL_CLASS} input.sse-debug-paste {
    width: 100%;
    box-sizing: border-box;
    margin-top: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: #eee;
    border: 1px solid rgba(120, 180, 255, 0.6);
    border-radius: 3px;
    padding: 4px 8px;
    font: inherit;
}
.${PANEL_CLASS} button.sse-debug-on {
    background: rgba(120, 180, 255, 0.35);
}
`;
const fmt = (v) => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
// Accepts "1,2,3", "1, 2, 3", "1 2 3", with or without trailing whitespace.
const parseVector = (text) => {
    const parts = text
        .trim()
        .split(/[\s,]+/)
        .filter((p) => p.length > 0);
    if (parts.length !== 3)
        return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n)))
        return null;
    return [nums[0], nums[1], nums[2]];
};
class DebugPanel {
    _global;
    _cameraManager;
    _picker;
    // the stochastic renderer when this viewer opted in, for its depth cull toggle and counts
    _splatRenderer;
    _cullButton = null;
    _taaButton = null;
    _poplessButton = null;
    _culledValue = null;
    _cullStatsFrames = 0;
    _cullStatsPending = false;
    _pickDepthOverlay = null;
    _focusTmp = new Vec3();
    _root = null;
    _style = null;
    _positionValue = null;
    _focusValue = null;
    _copyButton = null;
    _pasteButton = null;
    // shown when the clipboard cannot be read (a cross-origin iframe without clipboard-read):
    // the paste event of a focused field carries the text without that permission
    _pasteField = null;
    _miniStatsButton = null;
    // the viewer's MiniStats switch
    _miniStats;
    _screenshotButton = null;
    _pickDepthButton = null;
    _editing = null;
    _editCanceled = false;
    _visible = false;
    _onPrerender = () => this._render();
    // the cull state is decided inside the frame, so its row refreshes after it
    _onFrameEnd = () => this._renderCull();
    _onKeyDown = (event) => {
        // Ctrl+Shift+D — also accept Meta+Shift+D on macOS for parity
        if (!this._global.state.inputEnabled)
            return;
        if (event.code === 'KeyD' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            this.toggle();
        }
    };
    constructor(global, cameraManager, picker, splatRenderer = null, miniStats = null) {
        this._global = global;
        this._cameraManager = cameraManager;
        this._picker = picker;
        this._splatRenderer = splatRenderer;
        this._miniStats = miniStats;
        window.addEventListener('keydown', this._onKeyDown);
        if (global.config.debug) {
            this.show();
        }
    }
    show() {
        if (this._visible)
            return;
        this._visible = true;
        if (!this._root) {
            this._build();
        }
        this._root.style.display = '';
        this._global.app.on('prerender', this._onPrerender);
        this._global.app.on('frameend', this._onFrameEnd);
        if (this._global.config.exposeGlobals) {
            window.getCameraState = () => captureCameraState(this._cameraManager, this._global.state);
            window.setCameraState = (snapshot) => restoreCameraState(this._cameraManager, this._global.state, snapshot);
        }
        this._render();
    }
    hide() {
        if (!this._visible)
            return;
        this._visible = false;
        if (this._root) {
            this._root.style.display = 'none';
        }
        // the view is only reachable from the panel, so it goes with it
        this._setPickDepth(false);
        this._global.app.off('prerender', this._onPrerender);
        this._global.app.off('frameend', this._onFrameEnd);
        if (this._global.config.exposeGlobals) {
            delete window.getCameraState;
            delete window.setCameraState;
        }
    }
    toggle() {
        if (this._visible)
            this.hide();
        else
            this.show();
    }
    destroy() {
        this.hide();
        this._pickDepthOverlay?.destroy();
        this._pickDepthOverlay = null;
        window.removeEventListener('keydown', this._onKeyDown);
        if (this._root) {
            this._root.remove();
            this._root = null;
        }
        this._style?.remove();
        this._style = null;
    }
    _build() {
        // both live in the viewer's root, so each instance carries and removes its own
        const host = this._global.root;
        if (!this._style) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = STYLES;
            host.appendChild(style);
            this._style = style;
        }
        const root = document.createElement('div');
        root.className = PANEL_CLASS;
        root.innerHTML = `
            <div class="sse-debug-row"><span class="sse-debug-label">camera</span><span class="sse-debug-value" data-id="position" contenteditable="plaintext-only" spellcheck="false" title="Edit to set camera position">—</span></div>
            <div class="sse-debug-row"><span class="sse-debug-label">focus</span><span class="sse-debug-value" data-id="focus" contenteditable="plaintext-only" spellcheck="false" title="Edit to look at this point">—</span></div>
            <div class="sse-debug-buttons">
                <button data-id="copy">Copy</button>
                <button data-id="paste">Paste</button>
            </div>
            <div class="sse-debug-buttons">
                <button data-id="screenshot">Screenshot</button>
                <button data-id="pick-depth" title="Show the depth a navigation pick finds at every pixel">Show depth</button>
                <button data-id="ministats" title="Show the engine's MiniStats graphs (the viewer then renders every frame)">MiniStats</button>
            </div>
            <input class="sse-debug-paste" data-id="paste-field" placeholder="Clipboard blocked here: paste with Ctrl/Cmd+V" spellcheck="false" style="display: none">
            ${this._splatRenderer
            ? `
            <div class="sse-debug-buttons">
                <button data-id="depth-cull" title="Stochastic renderer: cull splats hidden in the previous frame's depth (auto suspends the test when it removes too little)">Depth cull</button>
                <button data-id="taa" title="Stochastic renderer: accumulate the samples over frames (reprojected while the camera moves)">TAA</button>
                <button data-id="popless" title="Stochastic renderer: give each fragment the depth of the Gaussian's peak along its ray, rather than the splat centre's">Popless</button>
            </div>
            <div class="sse-debug-row"><span class="sse-debug-label">culled</span><span class="sse-debug-value" data-id="culled">—</span></div>`
            : ''}
        `;
        host.appendChild(root);
        this._root = root;
        this._positionValue = root.querySelector('[data-id="position"]');
        this._focusValue = root.querySelector('[data-id="focus"]');
        this._copyButton = root.querySelector('[data-id="copy"]');
        this._pasteButton = root.querySelector('[data-id="paste"]');
        this._screenshotButton = root.querySelector('[data-id="screenshot"]');
        this._pickDepthButton = root.querySelector('[data-id="pick-depth"]');
        this._miniStatsButton = root.querySelector('[data-id="ministats"]');
        this._pasteField = root.querySelector('[data-id="paste-field"]');
        this._wirePasteField(this._pasteField);
        if (this._miniStats) {
            this._miniStatsButton.addEventListener('click', () => {
                this._miniStats.show(!this._miniStats.shown());
                this._renderMiniStats();
            });
            this._renderMiniStats();
        }
        else {
            this._miniStatsButton.remove();
        }
        this._copyButton.addEventListener('click', () => this._copy());
        this._pasteButton.addEventListener('click', () => this._paste());
        this._screenshotButton.addEventListener('click', () => this._screenshot());
        this._pickDepthButton.addEventListener('click', () => {
            this._setPickDepth(!this._pickDepthOverlay?.enabled);
        });
        if (this._splatRenderer) {
            this._cullButton = root.querySelector('[data-id="depth-cull"]');
            this._taaButton = root.querySelector('[data-id="taa"]');
            this._poplessButton = root.querySelector('[data-id="popless"]');
            this._poplessButton.addEventListener('click', () => {
                const renderer = this._splatRenderer;
                renderer.variant.popless = renderer.variant.popless === 'on' ? 'off' : 'on';
                renderer.applyVariant();
                this._renderCull();
            });
            this._culledValue = root.querySelector('[data-id="culled"]');
            this._taaButton.addEventListener('click', () => {
                const renderer = this._splatRenderer;
                renderer.variant.taa = renderer.variant.taa === 'on' ? 'off' : 'on';
                renderer.applyVariant();
                this._renderCull();
            });
            // cycles the cull mode: auto (the default) -> on (both grid levels) -> off
            this._cullButton.addEventListener('click', () => {
                const renderer = this._splatRenderer;
                const next = { auto: 'l2', l2: 'off', l1: 'off', off: 'auto' };
                renderer.variant.cull = next[renderer.variant.cull];
                renderer.applyVariant();
                this._renderCull();
            });
            this._renderCull();
        }
        this._wireEditable(this._positionValue, 'position');
        this._wireEditable(this._focusValue, 'focus');
    }
    _wireEditable(span, kind) {
        span.addEventListener('focus', () => {
            this._editing = span;
            this._editCanceled = false;
            // select all text so the user can start typing to replace
            const range = document.createRange();
            range.selectNodeContents(span);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
        // Stop key events from bubbling to the canvas / window listeners
        // (PlayCanvas KeyboardMouseSource and the wheel/key interrupt
        // listeners) so arrow keys, WASD, etc. behave as text editing
        // instead of moving the camera.
        const stopKey = (e) => e.stopPropagation();
        span.addEventListener('keydown', (e) => {
            stopKey(e);
            if (e.key === 'Enter') {
                e.preventDefault();
                span.blur();
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                this._editCanceled = true;
                span.blur();
            }
        });
        span.addEventListener('keyup', stopKey);
        span.addEventListener('keypress', stopKey);
        span.addEventListener('blur', () => {
            const wasCanceled = this._editCanceled;
            this._editing = null;
            this._editCanceled = false;
            // clear any leftover selection
            window.getSelection()?.removeAllRanges();
            if (wasCanceled) {
                this._render();
                return;
            }
            const parsed = parseVector(span.textContent ?? '');
            if (!parsed) {
                this._flashBad(span);
                this._render();
                return;
            }
            if (kind === 'position') {
                this._applyPosition(parsed);
            }
            else {
                this._applyFocus(parsed);
            }
            this._flashOk(span);
        });
    }
    _setPickDepth(value) {
        if (value && !this._pickDepthOverlay) {
            this._pickDepthOverlay = new PickDepthOverlay(this._global.app, this._global.camera, this._picker);
        }
        if (this._pickDepthOverlay) {
            this._pickDepthOverlay.enabled = value;
        }
        this._pickDepthButton?.classList.toggle('sse-debug-on', value);
    }
    _applyPosition(pos) {
        this._cameraManager.camera.position.set(pos[0], pos[1], pos[2]);
        this._cameraManager.snap();
    }
    _applyFocus(focus) {
        // Keep camera position fixed; recompute angles + distance so the
        // camera looks at the new focus point. Camera.look() does the math
        // in place; snap() then re-seeds the active controller.
        const cam = this._cameraManager.camera;
        const from = this._focusTmp.copy(cam.position);
        const to = new Vec3(focus[0], focus[1], focus[2]);
        cam.look(from, to);
        this._cameraManager.snap();
    }
    _render() {
        if (!this._visible || !this._positionValue || !this._focusValue)
            return;
        const cam = this._cameraManager.camera;
        cam.calcFocusPoint(this._focusTmp);
        // Skip the span currently being edited so user input isn't
        // overwritten by the per-frame refresh.
        if (this._editing !== this._positionValue) {
            this._positionValue.textContent = fmt(cam.position);
        }
        if (this._editing !== this._focusValue) {
            this._focusValue.textContent = fmt(this._focusTmp);
        }
    }
    // the cull button shows the mode; the counts come back from the gpu every few frames
    _renderCull() {
        const renderer = this._splatRenderer;
        if (!renderer || !this._cullButton || !this._culledValue)
            return;
        const mode = renderer.variant.cull;
        this._cullButton.textContent = `Depth cull: ${mode === 'off' ? 'off' : mode === 'auto' ? 'auto' : 'on'}`;
        this._cullButton.classList.toggle('sse-debug-on', mode !== 'off');
        if (this._taaButton) {
            this._taaButton.textContent = `TAA: ${renderer.variant.taa}`;
            this._taaButton.classList.toggle('sse-debug-on', renderer.variant.taa === 'on');
        }
        if (this._poplessButton) {
            this._poplessButton.textContent = `Popless: ${renderer.variant.popless}`;
            this._poplessButton.classList.toggle('sse-debug-on', renderer.variant.popless === 'on');
        }
        if (mode === 'off') {
            this._culledValue.textContent = 'off';
            return;
        }
        if (!renderer.culling) {
            this._culledValue.textContent = renderer.cullSuspended ? 'suspended' : 'no previous frame';
            return;
        }
        if (this._cullStatsPending || this._cullStatsFrames++ % 15 !== 0)
            return;
        this._cullStatsPending = true;
        renderer
            .readStats()
            .then(({ survivors, occluded }) => {
            const total = survivors + occluded;
            const pct = total > 0 ? ((100 * occluded) / total).toFixed(0) : '0';
            if (this._culledValue && renderer.culling) {
                this._culledValue.textContent = `${pct}% (${occluded.toLocaleString()} of ${total.toLocaleString()})`;
            }
        })
            .catch(() => {
            // a destroyed buffer or lost device; the next refresh tries again
        })
            .finally(() => {
            this._cullStatsPending = false;
        });
    }
    // The clipboard api, else a selection copied with execCommand: the api is refused in a
    // cross-origin iframe without clipboard-write (superspl.at's local-frontend frame), while
    // the command still works there inside the click
    async _copy() {
        const text = JSON.stringify(captureCameraState(this._cameraManager, this._global.state));
        let copied = false;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        }
        catch {
            // destroyed while the clipboard was refusing
            if (!this._root)
                return;
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position: fixed; opacity: 0; pointer-events: none';
            this._root.appendChild(area);
            area.select();
            try {
                copied = document.execCommand('copy');
            }
            catch {
                copied = false;
            }
            area.remove();
        }
        if (copied) {
            this._flash(this._copyButton);
        }
        else {
            console.warn('[debug-panel] copy failed');
            this._flashBad(this._copyButton);
        }
    }
    // The clipboard api, else the paste field: reading needs clipboard-read, which a
    // cross-origin iframe only has when its embedder grants it
    async _paste() {
        let text;
        try {
            text = await navigator.clipboard.readText();
        }
        catch {
            this._showPasteField(true);
            return;
        }
        // destroyed while the clipboard was being read
        if (!this._root)
            return;
        this._applyPasted(text);
    }
    _applyPasted(text) {
        try {
            const snapshot = JSON.parse(text);
            restoreCameraState(this._cameraManager, this._global.state, snapshot);
            this._flash(this._pasteButton);
        }
        catch (err) {
            console.warn('[debug-panel] paste failed', err);
            this._flashBad(this._pasteButton);
        }
    }
    _showPasteField(value) {
        const field = this._pasteField;
        if (!field)
            return;
        field.value = '';
        field.style.display = value ? '' : 'none';
        if (value)
            field.focus();
    }
    _wirePasteField(field) {
        // keys typed here are text, not camera controls (see _wireEditable)
        const stopKey = (e) => e.stopPropagation();
        field.addEventListener('keydown', (e) => {
            stopKey(e);
            if (e.key === 'Enter') {
                e.preventDefault();
                const text = field.value;
                this._showPasteField(false);
                this._applyPasted(text);
            }
            else if (e.key === 'Escape') {
                e.preventDefault();
                this._showPasteField(false);
            }
        });
        field.addEventListener('keyup', stopKey);
        field.addEventListener('keypress', stopKey);
        field.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData('text/plain') ?? '';
            this._showPasteField(false);
            this._applyPasted(text);
        });
        field.addEventListener('blur', () => this._showPasteField(false));
    }
    _renderMiniStats() {
        if (!this._miniStats || !this._miniStatsButton)
            return;
        const shown = this._miniStats.shown();
        this._miniStatsButton.textContent = `MiniStats: ${shown ? 'on' : 'off'}`;
        this._miniStatsButton.classList.toggle('sse-debug-on', shown);
    }
    _screenshot() {
        const app = this._global.app;
        const canvas = app.graphicsDevice.canvas;
        // PlayCanvas runs with preserveDrawingBuffer off, so the canvas
        // pixels are only readable in the same task as the render. Force
        // a render and capture in frameend.
        app.renderNextFrame = true;
        app.once('frameend', () => {
            // Quality 1.0 with image/webp produces lossless WebP in
            // Chromium / Firefox. Safari (which lacks WebP encode) falls
            // back to PNG automatically — blob.type tells us which.
            canvas.toBlob((blob) => {
                if (!blob) {
                    console.warn('[debug-panel] screenshot toBlob returned null');
                    return;
                }
                const ext = blob.type === 'image/webp' ? 'webp' : 'png';
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `supersplat-viewer.${ext}`;
                a.click();
                URL.revokeObjectURL(url);
                this._flash(this._screenshotButton);
            }, 'image/webp', 1.0);
        });
    }
    _flash(el) {
        if (!el)
            return;
        el.classList.add('sse-flash');
        setTimeout(() => el.classList.remove('sse-flash'), 250);
    }
    _flashOk(el) {
        el.classList.add('sse-flash-ok');
        setTimeout(() => el.classList.remove('sse-flash-ok'), 250);
    }
    _flashBad(el) {
        el.classList.add('sse-flash-bad');
        setTimeout(() => el.classList.remove('sse-flash-bad'), 400);
    }
}

// Browser integration shared by the built-in controls and embedding hosts.
const initFullscreen = ({ root, state, events }) => {
    const native = !!(root.requestFullscreen && document.exitFullscreen);
    let destroyed = false;
    const update = () => {
        if (!destroyed)
            state.isFullscreen = document.fullscreenElement === root;
    };
    if (native) {
        document.addEventListener('fullscreenchange', update);
        update();
    }
    const exit = async () => {
        if (native) {
            // Never close another viewer's (or the host page's) fullscreen element.
            if (document.fullscreenElement === root)
                await document.exitFullscreen();
            update();
        }
        else if (state.isFullscreen) {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };
    const request = async () => {
        if (native) {
            await root.requestFullscreen();
            // A request may finish after destruction. Release only our own element.
            if (destroyed)
                await exit();
            else
                update();
        }
        else if (window.parent !== window) {
            // Preserve the standalone iframe bridge. There is no acknowledgement protocol:
            // this is the requested state, not an observation of the parent's browser state.
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        }
        else {
            throw new Error('requestFullscreen: fullscreen is not supported');
        }
    };
    const cancel = events.on('inputEvent', (event) => {
        if (event === 'cancel')
            void exit().catch(() => {
                /* browser rejected the exit */
            });
    });
    return {
        request,
        exit,
        destroy: () => {
            destroyed = true;
            document.removeEventListener('fullscreenchange', update);
            cancel.off();
            void exit().catch(() => {
                /* removing the root also leaves native fullscreen */
            });
            state.isFullscreen = false;
        }
    };
};

/**
 * Watches pointer events over the instance root and updates `state.inputMode`
 * to reflect whether the user is on a touch device or desktop.
 */
class InputModeTracker {
    _global = null;
    _onPointer = (event) => {
        if (this._global) {
            this._global.state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
        }
    };
    attach(global) {
        this._global = global;
        global.root.addEventListener('pointerdown', this._onPointer);
        global.root.addEventListener('pointermove', this._onPointer);
    }
    detach() {
        this._global?.root.removeEventListener('pointerdown', this._onPointer);
        this._global?.root.removeEventListener('pointermove', this._onPointer);
        this._global = null;
    }
}

const isCaptureMode$1 = (mode) => mode === 'walk' || mode === 'fly';
const isWasdKey = (event) => event.code === 'KeyW' || event.code === 'KeyA' || event.code === 'KeyS' || event.code === 'KeyD';
// The shortcut a key press stands for. A key that types a Latin character keeps using it, so
// the shortcuts follow the key labels (Dvorak moves them, as it should). A key that types
// anything else, such as Cyrillic or Greek, falls back to its position on a US layout, the way
// WASD already works, so the shortcuts still work on every layout the ui is translated for.
const shortcutKey = (event) => {
    if (/^[\x20-\x7e]$/.test(event.key)) {
        return event.key;
    }
    const match = /^(?:Key([A-Z])|Digit(\d))$/.exec(event.code);
    return match ? (match[1]?.toLowerCase() ?? match[2]) : event.key;
};
/**
 * Keyboard shortcuts that switch camera mode and toggle UI affordances.
 * Listens on `window` so the user can press 1/2/3, V, G, H, F, R, Space,
 * or Escape regardless of which element has focus — unless the host has
 * cleared `state.inputEnabled`, which is how it routes the keyboard away.
 */
class ModeShortcuts {
    _global = null;
    _pointerLock = null;
    _onKeyDown = (event) => {
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (!state.inputEnabled)
            return;
        if (event.key === 'Escape') {
            if (this._pointerLock?.recentlyExitedCapture) ;
            else if (isCaptureMode$1(state.cameraMode) && state.gamingControls && state.inputMode === 'desktop') {
                state.gamingControls = false;
            }
            else if (state.cameraMode === 'walk') {
                events.fire('inputEvent', 'exitWalk', event);
            }
            else {
                events.fire('inputEvent', 'cancel', event);
            }
            return;
        }
        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }
        const key = shortcutKey(event);
        switch (key) {
            case '1':
                state.cameraMode = 'orbit';
                break;
            case '2':
                state.cameraMode = 'fly';
                break;
            case '3':
                events.fire('inputEvent', 'toggleWalk');
                break;
            case 'v':
                if (state.hasCollisionOverlay) {
                    state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
                }
                break;
            case 'g':
                state.gamingControls = !state.gamingControls;
                break;
            // H the controls panel, Shift+H the info panel. Shift is read from the event, so
            // caps lock does not swap them
            case 'h':
            case 'H':
                events.fire('inputEvent', event.shiftKey ? 'toggleHelp' : 'toggleControls');
                break;
            case 'r':
                events.fire('inputEvent', 'reset', event);
                break;
            default:
                if (isWasdKey(event) && state.inputMode === 'desktop') {
                    if (!isCaptureMode$1(state.cameraMode)) {
                        events.fire('inputEvent', 'requestFirstPerson');
                    }
                    if (!state.gamingControls) {
                        state.gamingControls = true;
                    }
                }
                break;
        }
        if (state.cameraMode !== 'walk') {
            switch (key) {
                case 'f':
                    events.fire('inputEvent', 'frame', event);
                    break;
                case ' ':
                    events.fire('inputEvent', 'playPause', event);
                    break;
            }
        }
    };
    attach(global, pointerLock) {
        this._global = global;
        this._pointerLock = pointerLock;
        window.addEventListener('keydown', this._onKeyDown);
    }
    detach() {
        window.removeEventListener('keydown', this._onKeyDown);
        this._global = null;
        this._pointerLock = null;
    }
}

const tmpV$4 = new Vec3();
const canTargetFly = (global) => global.state.cameraMode === 'fly' && !(global.state.inputMode === 'desktop' && global.state.gamingControls);
// Mirror gaming-controls speed modifiers: shift = run/boost, ctrl = crawl/slow.
// Multipliers match keyboard-mouse.ts so click-nav and held-key movement feel the same.
const computeClickSpeedMul = (event, mode) => {
    if (!event)
        return 1;
    if (mode === 'walk') {
        if (event.shiftKey)
            return 2;
        if (event.ctrlKey)
            return 0.5;
    }
    else if (mode === 'fly') {
        if (event.shiftKey)
            return 4;
        if (event.ctrlKey)
            return 0.25;
    }
    return 1;
};
/**
 * Click-to-walk / click-to-fly / click-to-focus (desktop), tap equivalents
 * on mobile, and double-click-to-pick fallback. Uses collision first and
 * rendered-scene picking when collision is unavailable.
 */
class NavInteraction {
    collision = null;
    _picker;
    _global = null;
    _canvas = null;
    _lastPointerOffsetX = 0;
    _lastPointerOffsetY = 0;
    _mouseClickTracking = false;
    _mouseClickDelta = 0;
    _suppressClick = false;
    _targetPickRequest = 0;
    _lastTap = { time: 0, x: 0, y: 0 };
    constructor(picker) {
        this._picker = picker;
    }
    _updateCursor = () => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas)
            return;
        const { state } = global;
        const canClickTarget = state.inputMode === 'desktop' &&
            ((state.cameraMode === 'walk' && !state.gamingControls) ||
                canTargetFly(global) ||
                state.cameraMode === 'orbit');
        if (canClickTarget) {
            canvas.style.cursor = this._mouseClickTracking ? 'default' : 'pointer';
        }
        else {
            canvas.style.cursor = '';
        }
    };
    _onCameraModeChanged = () => {
        this._targetPickRequest++;
        this._updateCursor();
    };
    _pickCollision(offsetX, offsetY) {
        if (!this.collision || !this._global)
            return null;
        const camera = this._global.camera;
        const cameraPos = camera.getPosition();
        camera.camera.screenToWorld(offsetX, offsetY, 1.0, tmpV$4);
        tmpV$4.sub(cameraPos).normalize();
        const hit = this.collision.queryRay(cameraPos.x, cameraPos.y, cameraPos.z, tmpV$4.x, tmpV$4.y, tmpV$4.z, camera.camera.farClip);
        if (!hit)
            return null;
        const sn = this.collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV$4.x, tmpV$4.y, tmpV$4.z);
        return {
            position: new Vec3(hit.x, hit.y, hit.z),
            normal: new Vec3(sn.nx, sn.ny, sn.nz)
        };
    }
    async _pickSceneTarget(offsetX, offsetY) {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas)
            return null;
        const collisionTarget = this._pickCollision(offsetX, offsetY);
        if (collisionTarget) {
            return collisionTarget;
        }
        const result = await this._picker.pickSurface(offsetX / canvas.clientWidth, offsetY / canvas.clientHeight);
        if (result) {
            return result;
        }
        return null;
    }
    async _flyToPickedPosition(offsetX, offsetY, event) {
        const global = this._global;
        if (!global || !canTargetFly(global))
            return;
        const request = ++this._targetPickRequest;
        const target = await this._pickSceneTarget(offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._global && canTargetFly(this._global)) {
            const speedMul = computeClickSpeedMul(event, this._global.state.cameraMode);
            this._global.events.fire('navigateTo', target.position, target.normal, speedMul);
        }
    }
    async _focusPickedPosition(offsetX, offsetY) {
        const global = this._global;
        if (!global || global.state.cameraMode !== 'orbit')
            return;
        const request = ++this._targetPickRequest;
        const target = await this._pickSceneTarget(offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._global?.state.cameraMode === 'orbit') {
            const { events } = this._global;
            events.fire('orbitTarget:set', target.position, target.normal);
            events.fire('pick', target.position);
        }
    }
    _onPointerDown = (event) => {
        const global = this._global;
        if (!global)
            return;
        const { events } = global;
        // record offsets for click/tap target picking
        this._lastPointerOffsetX = event.offsetX;
        this._lastPointerOffsetY = event.offsetY;
        // start desktop click target tracking
        if (event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = true;
            this._mouseClickDelta = 0;
            this._updateCursor();
        }
        // Manual double-click/tap detection for platforms that do not emit
        // reliable native dblclick events on the canvas.
        const now = Date.now();
        const delay = Math.max(0, now - this._lastTap.time);
        if (delay < 300 &&
            Math.abs(event.clientX - this._lastTap.x) < 8 &&
            Math.abs(event.clientY - this._lastTap.y) < 8) {
            this._suppressClick = true;
            events.fire('inputEvent', 'dblclick', event);
            this._lastTap.time = 0;
        }
        else {
            this._lastTap.time = now;
            this._lastTap.x = event.clientX;
            this._lastTap.y = event.clientY;
        }
    };
    _onPointerMove = (event) => {
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (this._mouseClickTracking && event.pointerType !== 'touch') {
            const prev = this._mouseClickDelta;
            this._mouseClickDelta += Math.abs(event.movementX) + Math.abs(event.movementY);
            if (prev < TAP_EPSILON && this._mouseClickDelta >= TAP_EPSILON) {
                if ((state.cameraMode === 'walk' && !state.gamingControls) || canTargetFly(global)) {
                    events.fire('navigateCancel');
                }
            }
        }
    };
    _onPointerUp = (event) => {
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (this._mouseClickTracking && event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = false;
            this._updateCursor();
            if (this._suppressClick) {
                this._suppressClick = false;
                return;
            }
            if (this._mouseClickDelta < TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
                    if (result) {
                        const speedMul = computeClickSpeedMul(event, state.cameraMode);
                        events.fire('navigateTo', result.position, result.normal, speedMul);
                    }
                }
                else if (state.cameraMode === 'fly') {
                    this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY, event);
                }
                else if (state.cameraMode === 'orbit') {
                    this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
                }
            }
        }
    };
    _onInputEvent = async (eventName, event) => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas)
            return;
        if (eventName !== 'dblclick')
            return;
        if (!(event instanceof MouseEvent))
            return;
        const { events, state } = global;
        // dblclick/double-tap in gaming controls does nothing, like click/tap
        if ((state.cameraMode === 'walk' || state.cameraMode === 'fly') && state.gamingControls)
            return;
        const request = ++this._targetPickRequest;
        const target = await this._pickSceneTarget(event.offsetX, event.offsetY);
        if (!target || request !== this._targetPickRequest)
            return;
        const currentState = this._global?.state;
        if (!currentState)
            return;
        if (currentState.cameraMode === 'walk') {
            if (!currentState.gamingControls) {
                // run to the picked point (same multiplier as shift-click)
                events.fire('navigateTo', target.position, target.normal, 2);
            }
        }
        else {
            // in other modes dblclick focuses orbit on the picked point.
            // 'pick' switches mode to orbit, which cancels any active navigation
            // and would clobber a pre-set orbit target — set it after.
            events.fire('pick', target.position);
            events.fire('orbitTarget:set', target.position, target.normal);
        }
    };
    _onMobileTap = () => {
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (this._suppressClick) {
            this._suppressClick = false;
            return;
        }
        if (state.cameraMode === 'walk' && !state.gamingControls) {
            const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
            if (result) {
                events.fire('navigateTo', result.position, result.normal);
            }
        }
        else if (state.cameraMode === 'fly') {
            this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        }
        else if (state.cameraMode === 'orbit') {
            this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        }
    };
    attach(canvas, global) {
        this._canvas = canvas;
        this._global = global;
        const { events } = global;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        // double-click/tap fallback -> run to walk target or orbit focus
        events.on('inputEvent', this._onInputEvent);
        // mobile tap (no movement) → walk/fly target or orbit focus
        events.on('mobileTap', this._onMobileTap);
        // refresh cursor on mode / gaming-controls change
        events.on('cameraMode:changed', this._onCameraModeChanged);
        events.on('inputMode:changed', this._updateCursor);
        events.on('gamingControls:changed', this._updateCursor);
    }
    detach() {
        if (this._canvas) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._canvas.removeEventListener('pointermove', this._onPointerMove);
            this._canvas.removeEventListener('pointerup', this._onPointerUp);
        }
        if (this._global) {
            const { events } = this._global;
            events.off('inputEvent', this._onInputEvent);
            events.off('mobileTap', this._onMobileTap);
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('inputMode:changed', this._updateCursor);
            events.off('gamingControls:changed', this._updateCursor);
        }
        this._canvas = null;
        this._global = null;
    }
}

const isCaptureMode = (mode) => mode === 'walk' || mode === 'fly';
const hasUserActivation = () => navigator.userActivation?.isActive === true;
/**
 * Manages the browser's pointer-lock API for first-person gaming controls
 * on desktop. Toggles in response to camera mode, input mode, and
 * gaming-controls changes, and reverts state if the lock is exited or rejected.
 *
 * Also exposes `recentlyExitedCapture` so the keyboard-shortcut handler can
 * de-duplicate the Escape keydown that triggered the lock exit.
 */
class PointerLockManager {
    _global = null;
    _canvas = null;
    _keyboardMouse = null;
    _recentlyExitedCapture = false;
    _onPointerLockChange = () => {
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (!document.pointerLockElement && isCaptureMode(state.cameraMode) && state.gamingControls) {
            this._recentlyExitedCapture = true;
            requestAnimationFrame(() => {
                this._recentlyExitedCapture = false;
            });
            if (state.inputMode === 'desktop') {
                state.gamingControls = false;
            }
            else if (state.cameraMode === 'walk') {
                events.fire('inputEvent', 'exitWalk');
            }
        }
    };
    _onPointerLockError = () => {
        // Pointer lock request rejected (no user gesture, document hidden,
        // etc). Revert state so we don't end up stuck in walk mode without
        // mouse capture.
        if (this._keyboardMouse) {
            this._keyboardMouse.source._pointerLock = false;
        }
        const global = this._global;
        if (!global)
            return;
        const { state, events } = global;
        if (state.inputMode === 'desktop' && isCaptureMode(state.cameraMode)) {
            state.gamingControls = false;
        }
        else if (state.cameraMode === 'walk') {
            events.fire('inputEvent', 'exitWalk');
        }
    };
    _onCameraModeChanged = (value, prev) => {
        const state = this._global?.state;
        if (!state)
            return;
        if (isCaptureMode(value) && state.inputMode === 'desktop' && state.gamingControls) {
            this._activate();
        }
        else if (isCaptureMode(prev)) {
            this._deactivate();
        }
    };
    _onGamingControlsChanged = (value) => {
        const state = this._global?.state;
        if (!state)
            return;
        if (isCaptureMode(state.cameraMode) && state.inputMode === 'desktop') {
            if (value) {
                this._activate();
            }
            else {
                this._deactivate();
            }
        }
    };
    _onInputModeChanged = (value) => {
        const state = this._global?.state;
        if (!state || !isCaptureMode(state.cameraMode) || !state.gamingControls) {
            return;
        }
        if (value === 'desktop' && hasUserActivation()) {
            this._activate();
        }
        else if (value !== 'desktop') {
            this._deactivate();
        }
    };
    _onPointerDown = () => {
        const state = this._global?.state;
        if (state && state.inputMode === 'desktop' && isCaptureMode(state.cameraMode) && state.gamingControls) {
            this._activate();
        }
    };
    _activate() {
        if (this._keyboardMouse) {
            this._keyboardMouse.source._pointerLock = true;
        }
        if (document.pointerLockElement !== this._canvas) {
            this._canvas?.requestPointerLock();
        }
    }
    _deactivate() {
        if (this._keyboardMouse) {
            this._keyboardMouse.source._pointerLock = false;
        }
        if (document.pointerLockElement === this._canvas) {
            document.exitPointerLock();
        }
    }
    get recentlyExitedCapture() {
        return this._recentlyExitedCapture;
    }
    attach(canvas, global, keyboardMouse) {
        this._canvas = canvas;
        this._global = global;
        this._keyboardMouse = keyboardMouse;
        const { events } = global;
        events.on('cameraMode:changed', this._onCameraModeChanged);
        events.on('gamingControls:changed', this._onGamingControlsChanged);
        events.on('inputMode:changed', this._onInputModeChanged);
        canvas.addEventListener('pointerdown', this._onPointerDown);
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        document.addEventListener('pointerlockerror', this._onPointerLockError);
    }
    detach() {
        if (this._global) {
            const { events } = this._global;
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('gamingControls:changed', this._onGamingControlsChanged);
            events.off('inputMode:changed', this._onInputModeChanged);
        }
        this._canvas?.removeEventListener('pointerdown', this._onPointerDown);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        document.removeEventListener('pointerlockerror', this._onPointerLockError);
        this._canvas = null;
        this._global = null;
        this._keyboardMouse = null;
    }
}

const tmpV$3 = new Vec3();
const stickMove = new Vec3();
const stickRotate = new Vec3();
class GamepadDevice {
    moveSpeed = 4;
    orbitSpeed = 18;
    gamepadRotateSensitivity = 1.0;
    _source = new GamepadSource();
    _global = null;
    attach(_canvas, global) {
        this._global = global;
        // GamepadSource polls navigator.getGamepads() — no DOM attach needed.
    }
    detach() {
        this._global = null;
    }
    update(ctx, frame) {
        // the gamepad belongs to the page, not to an element; the host says which instance
        // it drives
        if (!this._global?.state.inputEnabled)
            return;
        const { dt, cameraComponent, isFly, isFirstPerson } = ctx;
        const { leftStick, rightStick } = this._source.read();
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;
        if (isFly && (leftStick[0] !== 0 || leftStick[1] !== 0 || rightStick[0] !== 0 || rightStick[1] !== 0)) {
            this._global?.events.fire('navigateCancel');
        }
        const v = tmpV$3.set(0, 0, 0);
        stickMove.set(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);
        v.set(0, 0, 0);
        stickRotate.set(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * this.gamepadRotateSensitivity * dt));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

const tmpV1 = new Vec3();
const tmpV2 = new Vec3();
const keyMove = new Vec3();
const flyKeyVelocity = new Vec3();
const panMove = new Vec3();
const mouseRotate = new Vec3();
const wheelMove = new Vec3();
// Patch keydown / keyup so meta-key combinations don't leave keys stuck on
// macOS (the OS swallows keyup for any key released while Cmd is held), and so
// keydown is turned away while the host has input disabled: the engine source
// listens on window, so this is the only place a key can be refused.
const patchKeyboardMeta = (desktopInput, enabled) => {
    const origOnKeyDown = desktopInput._onKeyDown;
    desktopInput._onKeyDown = (event) => {
        if (!enabled())
            return;
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        }
        else if (!event.metaKey) {
            origOnKeyDown(event);
        }
    };
    const origOnKeyUp = desktopInput._onKeyUp;
    desktopInput._onKeyUp = (event) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        }
        else if (!event.metaKey) {
            origOnKeyUp(event);
        }
    };
};
class KeyboardMouseDevice {
    moveSpeed = 4;
    orbitSpeed = 18;
    wheelSpeed = 0.06;
    mouseRotateSensitivity = 0.5;
    flyMoveAccelerationDamping = 0.992;
    flyMoveDecelerationDamping = 0.993;
    _source = new KeyboardMouseSource();
    _global = null;
    /** Running WASD/QE/arrow direction (sum of key states). */
    _axis = new Vec3();
    /** Running button-held state per index: [LMB, MMB, RMB]. */
    _buttons = [0, 0, 0];
    _shift = 0;
    _ctrl = 0;
    _jump = 0;
    _flyKeyVelocity = new Vec3();
    // release every held key when the host disables input, so none can stick; the
    // releases reach `update` as ordinary deltas and unwind the running axis
    _onInputEnabled = (enabled) => {
        if (!enabled) {
            this._source._keyNow.fill(0);
        }
    };
    /**
     * Get the underlying source so other code (PointerLockManager) can
     * toggle its private pointer-lock flag, which gates how it consumes
     * mouse-delta events.
     *
     * @returns The PlayCanvas KeyboardMouseSource backing this device.
     */
    get source() {
        return this._source;
    }
    attach(canvas, global) {
        this._global = global;
        patchKeyboardMeta(this._source, () => global.state.inputEnabled);
        this._source.attach(canvas);
        global.events.on('inputEnabled:changed', this._onInputEnabled);
    }
    detach() {
        this._global?.events.off('inputEnabled:changed', this._onInputEnabled);
        this._source.detach();
        this._global = null;
    }
    update(ctx, frame) {
        const { keyCode } = KeyboardMouseSource;
        const { key, button, mouse, wheel } = this._source.read();
        const { events } = this._global;
        // accumulate running input state
        this._axis.add(tmpV1.set(key[keyCode.D] - key[keyCode.A] + (key[keyCode.RIGHT] - key[keyCode.LEFT]), key[keyCode.E] - key[keyCode.Q], key[keyCode.W] - key[keyCode.S] + (key[keyCode.UP] - key[keyCode.DOWN])));
        this._jump += key[keyCode.SPACE];
        this._shift += key[keyCode.SHIFT];
        this._ctrl += key[keyCode.CTRL];
        const n = Math.min(button.length, this._buttons.length);
        for (let i = 0; i < n; i++) {
            this._buttons[i] += button[i];
        }
        const { isFly, isWalk, isFirstPerson, gamingControls, dt, distance, cameraComponent, mode, touchCount } = ctx;
        const pan = this._buttons[2] || +(button[2] === -1) || +(touchCount > 1);
        // auto-move cancellation and requestFirstPerson events (driven by keyboard axes)
        if (isWalk && (this._axis.x !== 0 || this._axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && (this._axis.x !== 0 || this._axis.y !== 0 || this._axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && wheel[0] !== 0) {
            events.fire('navigateCancel');
        }
        if (isFly && (gamingControls || pan) && (mouse[0] !== 0 || mouse[1] !== 0)) {
            events.fire('navigateCancel');
        }
        if (!isFirstPerson && this._axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;
        // move (WASD + mouse-drag pan + wheel)
        const v = tmpV1.set(0, 0, 0);
        keyMove.copy(this._axis);
        if (isWalk) {
            // In walk mode normalize only horizontal axes so jump doesn't
            // reduce horizontal speed.
            keyMove.y = 0;
        }
        keyMove.normalize();
        const shiftMul = isWalk ? 2 : 4;
        const ctrlMul = isWalk ? 0.5 : 0.25;
        const speed = this.moveSpeed * (this._shift ? shiftMul : this._ctrl ? ctrlMul : 1);
        keyMove.mulScalar(speed);
        if (isFly) {
            flyKeyVelocity.copy(keyMove);
            const damping = flyKeyVelocity.lengthSq() > this._flyKeyVelocity.lengthSq()
                ? this.flyMoveAccelerationDamping
                : this.flyMoveDecelerationDamping;
            this._flyKeyVelocity.lerp(this._flyKeyVelocity, flyKeyVelocity, damp(damping, dt));
            if (flyKeyVelocity.lengthSq() === 0 && this._flyKeyVelocity.lengthSq() < 1e-4) {
                this._flyKeyVelocity.set(0, 0, 0);
            }
            keyMove.copy(this._flyKeyVelocity);
        }
        else {
            this._flyKeyVelocity.set(0, 0, 0);
        }
        v.add(tmpV2.copy(keyMove).mulScalar((isFirstPerson ? 1 : 0) * dt));
        if (isWalk) {
            // Pass jump signal as raw Y; WalkController uses move[1] > 0 as
            // a boolean trigger.
            v.y = this._jump > 0 ? 1 : 0;
        }
        screenToWorld(cameraComponent, mouse[0], mouse[1], distance, panMove);
        v.add(panMove.mulScalar(pan));
        wheelMove.set(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * DISPLACEMENT_SCALE));
        deltas.move.append([v.x, v.y, flipZForOrbit(mode, v.z)]);
        // rotate (mouse-drag, masked when in pan mode)
        v.set(0, 0, 0);
        mouseRotate.set(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * this.mouseRotateSensitivity * DISPLACEMENT_SCALE));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

const tmpV$2 = new Vec3();
const orbitMove = new Vec3();
const pinchMoveTmp = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();
class TouchDevice {
    orbitSpeed = 18;
    pinchSpeed = 0.4;
    touchRotateSensitivity = 1.5;
    _source = new MultiTouchSource();
    _global = null;
    /** Touches currently active (running count from .read() deltas). */
    _touchCount = 0;
    /** Tap-detection state — touch count, max touches, and accumulated movement. */
    _tapTouches = 0;
    _tapMaxTouches = 0;
    _tapDelta = 0;
    /** True for one frame after a tap is detected during gaming controls. */
    _tapJump = false;
    get touchCount() {
        return this._touchCount;
    }
    attach(canvas, global) {
        this._global = global;
        this._source.attach(canvas);
    }
    detach() {
        this._source.detach();
        this._global = null;
    }
    update(ctx, frame) {
        const { touch, pinch, count } = this._source.read();
        const { isFly, isWalk, isFirstPerson, isOrbit, gamingControls, distance, cameraComponent } = ctx;
        // running touch count
        this._touchCount += count[0];
        // tap detection for click/tap target and focus modes
        if (isWalk || isFly || isOrbit) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);
            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }
            if (this._tapTouches > 0) {
                this._tapMaxTouches = Math.max(this._tapMaxTouches, this._tapTouches);
            }
            if (this._tapTouches > 0) {
                const prevDelta = this._tapDelta;
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]) + Math.abs(pinch[0]);
                if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                    if ((isWalk && !gamingControls) || isFly) {
                        this._global.events.fire('navigateCancel');
                    }
                }
            }
            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                    if (isWalk && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global.events.fire('mobileTap');
                    }
                    else if (isWalk) {
                        this._tapJump = true;
                    }
                    else if (isFly && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global.events.fire('mobileTap');
                    }
                    else if (isOrbit) {
                        // Walk-interaction listens for this and sets orbit focus
                        // after picking.
                        this._global.events.fire('mobileTap');
                    }
                }
                this._tapMaxTouches = 0;
            }
        }
        else {
            this._tapTouches = 0;
            this._tapMaxTouches = 0;
        }
        const orbit = isOrbit ? 1 : 0;
        const fly = isFirstPerson ? 1 : 0;
        const double = this._touchCount > 1 ? 1 : 0;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const dragInvert = isFirstPerson && !gamingControls ? -1 : 1;
        // First-person modes (fly and walk) opt into the direct two-finger
        // model only outside gaming controls (gaming uses the joystick).
        const directFirstPerson = fly * (gamingControls ? 0 : 1);
        const { deltas } = frame;
        // move
        const v = tmpV$2.set(0, 0, 0);
        // Two-finger pan: orbit pans the target; fly strafes/rises in the
        // camera basis; walk strafes along the ground plane. Identical 1:1
        // screen-space mapping in every mode so dragging feels the same —
        // what your fingers move, the camera moves. Walk zeros y because
        // WalkController treats any nonzero move[1] as a jump trigger.
        screenToWorld(cameraComponent, touch[0], touch[1], distance, orbitMove);
        if (isWalk) {
            orbitMove.y = 0;
        }
        v.add(orbitMove.mulScalar((orbit + directFirstPerson) * double));
        // Two-finger pinch z: orbit interprets +z as "farther from target"
        // (close-pinch = +pinch[0] = zoom out). First-person modes interpret
        // +z as "forward", so spreading (pinch[0] < 0) should move forward —
        // flip the sign there.
        pinchMoveTmp.set(0, 0, (orbit - directFirstPerson) * pinch[0]);
        v.add(pinchMoveTmp.mulScalar(double * this.pinchSpeed * DISPLACEMENT_SCALE));
        // tap-to-jump in walk + gaming controls
        if (isWalk && this._tapJump) {
            v.y = 1;
            this._tapJump = false;
        }
        deltas.move.append([v.x, v.y, v.z]);
        // rotate
        v.set(0, 0, 0);
        // single-touch orbit rotate (masked when there are 2+ touches)
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - double) * this.orbitSpeed * this.touchRotateSensitivity * DISPLACEMENT_SCALE));
        // single-touch fly look (inverted in non-gaming first-person)
        flyRotate.set(touch[0] * dragInvert, touch[1] * dragInvert, 0);
        v.add(flyRotate.mulScalar(fly * (1 - double) * this.orbitSpeed * orbitFactor * this.touchRotateSensitivity * DISPLACEMENT_SCALE));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

const tmpV$1 = new Vec3();
class TrackpadDevice {
    orbitSpeed = 18;
    wheelSpeed = 0.06;
    trackpadOrbitSensitivity = 0.75;
    trackpadPanSensitivity = 1.0;
    trackpadZoomSensitivity = 2.0;
    _global = null;
    _orbit = [0, 0];
    _pan = [0, 0];
    _zoom = 0;
    // Tracks physical Ctrl key state so we can distinguish macOS-synthesized
    // pinch events (wheel + ctrlKey, no physical Ctrl) from a user holding
    // Ctrl while spinning a mouse wheel. The synthetic-Ctrl signal is the
    // one reliable trackpad indicator the platform gives us — every other
    // per-event heuristic has been tried (wheelDelta % 120, deltaMode,
    // fractional/diagonal deltas) and misfires on hi-res mice or in
    // momentum tails. Modifier-key state we can trust 100%.
    _ctrlDown = false;
    _onKeyDown = (event) => {
        if (event.key === 'Control' && this._global?.state.inputEnabled) {
            this._ctrlDown = true;
        }
    };
    _onKeyUp = (event) => {
        if (event.key === 'Control') {
            this._ctrlDown = false;
        }
    };
    // Window blur (alt-tab, focus another app) drops keyup events, so
    // clear Ctrl state defensively to avoid getting stuck.
    _onBlur = () => {
        this._ctrlDown = false;
    };
    _onWheel = (event) => {
        const mode = this._global.state.cameraMode;
        // Synthetic Ctrl (macOS pinch-to-zoom, Magic Mouse pinch): ctrlKey
        // is true on the event but the user isn't physically holding Ctrl.
        // Routes to trackpad-tuned zoom.
        const isPinch = event.ctrlKey && !this._ctrlDown;
        // Physical Ctrl + wheel/swipe: rotate. In orbit mode rotates around
        // the target; in fly/walk mode looks around. Applies to both mouse
        // wheel and trackpad swipe — we can't distinguish them, and the
        // modifier signals intent either way.
        // Corner case: user physically holds Ctrl AND pinches at the same
        // time — both flags are true, the gesture lands here as rotate
        // rather than pinch. Intentional: physical Ctrl is the explicit
        // signal, so it wins over the synthetic-Ctrl pinch heuristic.
        const isCtrlRotate = event.ctrlKey && this._ctrlDown;
        // Shift + wheel/swipe: pan (= strafe + vertical) in all modes. The
        // downstream camera controllers translate the screen-space pan
        // vector appropriately (orbit pans around the target plane; fly
        // strafes sideways and translates vertically; walk strafes).
        const isShiftPan = event.shiftKey;
        if (!isPinch && !isCtrlRotate && !isShiftPan) {
            // Bare wheel (mouse or trackpad swipe), unmodified fly/walk
            // wheels — all fall through to KeyboardMouseDevice for
            // standard forward/back motion (which dollys toward the orbit
            // target in orbit mode via flipZForOrbit, giving the universal
            // bare-scroll-zooms behavior).
            return;
        }
        event.preventDefault();
        // stopImmediatePropagation() blocks KeyboardMouseSource's wheel
        // handler (also attached to this canvas) so the wheel delta
        // doesn't double-up on the existing forward/back path. It also
        // blocks the canvas-level interrupt listener registered elsewhere,
        // so fire interrupt explicitly to keep parity with mouse-wheel.
        event.stopImmediatePropagation();
        this._global.events.fire('inputEvent', 'interrupt', event);
        if (mode === 'fly') {
            this._global.events.fire('navigateCancel');
        }
        const { deltaX, deltaY } = event;
        if (isPinch) {
            this._zoom += deltaY;
        }
        else if (isCtrlRotate) {
            this._orbit[0] += deltaX;
            this._orbit[1] += deltaY;
        }
        else {
            this._pan[0] += deltaX;
            this._pan[1] += deltaY;
        }
    };
    _canvas = null;
    /**
     * Trackpad must attach BEFORE KeyboardMouseSource so its
     * `stopImmediatePropagation()` blocks the mouse-source wheel handler
     * for trackpad bursts. The coordinator enforces this by attaching
     * trackpad before keyboard-mouse.
     *
     * Keyboard listeners attach on `window` (not the canvas) so we still
     * see Ctrl keydown/keyup when focus is on a UI overlay.
     *
     * @param canvas - The canvas element to listen to.
     * @param global - The global app context (state, events, etc.).
     */
    attach(canvas, global) {
        this._canvas = canvas;
        this._global = global;
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('blur', this._onBlur);
    }
    detach() {
        if (this._canvas) {
            this._canvas.removeEventListener('wheel', this._onWheel);
            this._canvas = null;
        }
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        this._global = null;
        this._ctrlDown = false;
        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }
    update(ctx, frame) {
        const { isOrbit, isFirstPerson, distance, cameraComponent } = ctx;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;
        if (isOrbit) {
            // Ctrl + scroll → orbit rotate
            const v = tmpV$1.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);
            // shift + scroll → pan in world space (matches desktop pan path); reuse tmpV after rotate append
            screenToWorld(cameraComponent, this._pan[0], this._pan[1], distance, tmpV$1);
            tmpV$1.mulScalar(this.trackpadPanSensitivity);
            deltas.move.append([tmpV$1.x, tmpV$1.y, 0]);
            // synthetic-Ctrl pinch → zoom along z; positive deltaY (scroll-down / pinch-in) → zoom out → +z for orbit
            const zoomZ = this._zoom * this.wheelSpeed * this.trackpadZoomSensitivity * DISPLACEMENT_SCALE;
            deltas.move.append([0, 0, zoomZ]);
        }
        else if (isFirstPerson) {
            // Ctrl + scroll → look around in fly/walk
            const v = tmpV$1.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * orbitFactor * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);
            // shift + scroll → strafe (X) + vertical (Y) via the same
            // screen-space pan pipeline as orbit mode; the fly/walk
            // controllers translate this into sideways/vertical motion
            screenToWorld(cameraComponent, this._pan[0], this._pan[1], distance, tmpV$1);
            tmpV$1.mulScalar(this.trackpadPanSensitivity);
            deltas.move.append([tmpV$1.x, tmpV$1.y, 0]);
            // synthetic-Ctrl pinch → forward/back along z (same sign as the
            // bare-wheel path in KeyboardMouseDevice, so pinch and scroll
            // produce identical motion in fly/walk modes)
            const moveZ = -this._zoom * this.wheelSpeed * this.trackpadZoomSensitivity * DISPLACEMENT_SCALE;
            deltas.move.append([0, 0, moveZ]);
        }
        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }
}

/**
 * Coordinator that wires together input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and app-level UX helpers (mode shortcuts, nav
 * interaction, pointer lock, input-mode tracker), and exposes the
 * resulting per-frame `InputFrame` for the camera manager to consume.
 */
class InputController {
    moveSpeed = 4;
    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });
    _global;
    _trackpad = new TrackpadDevice();
    _keyboardMouse = new KeyboardMouseDevice();
    _touch = new TouchDevice();
    _gamepad = new GamepadDevice();
    _navInteraction;
    _pointerLock = new PointerLockManager();
    _modeShortcuts = new ModeShortcuts();
    _inputModeTracker = new InputModeTracker();
    _canvas;
    _canvasListeners = [];
    _moveInput = [0, 0];
    _clearMoveInput = () => this._moveInput.fill(0);
    setMoveInput(x, z) {
        const { state } = this._global;
        if ((state.cameraMode === 'fly' || state.cameraMode === 'walk') && state.xrMode === null) {
            this._moveInput[0] = x;
            this._moveInput[1] = z;
        }
    }
    set collision(value) {
        this._navInteraction.collision = value;
    }
    get collision() {
        return this._navInteraction.collision;
    }
    constructor(global, picker) {
        this._global = global;
        this._navInteraction = new NavInteraction(picker);
        const { app, events } = global;
        const canvas = app.graphicsDevice.canvas;
        this._canvas = canvas;
        // Trackpad MUST attach before KeyboardMouseDevice so its wheel
        // handler runs first; otherwise stopImmediatePropagation can't
        // block KeyboardMouseSource from also accumulating the wheel delta.
        this._trackpad.attach(canvas, global);
        this._keyboardMouse.attach(canvas, global);
        this._touch.attach(canvas, global);
        this._gamepad.attach(canvas, global);
        this._navInteraction.attach(canvas, global);
        this._pointerLock.attach(canvas, global, this._keyboardMouse);
        this._modeShortcuts.attach(global, this._pointerLock);
        this._inputModeTracker.attach(global);
        events.on('cameraMode:changed', this._clearMoveInput);
        events.on('xrMode:changed', this._clearMoveInput);
        window.addEventListener('blur', this._clearMoveInput);
        document.addEventListener('visibilitychange', this._clearMoveInput);
        // canvas-level signals: anything that interrupts an animation /
        // closes the settings panel
        const listen = (eventName, handler) => {
            canvas.addEventListener(eventName, handler);
            this._canvasListeners.push([eventName, handler]);
        };
        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            listen(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });
        listen('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });
    }
    /** Detach every device and helper, and remove the canvas listeners added above. */
    destroy() {
        this._clearMoveInput();
        this._global.events.off('cameraMode:changed', this._clearMoveInput);
        this._global.events.off('xrMode:changed', this._clearMoveInput);
        window.removeEventListener('blur', this._clearMoveInput);
        document.removeEventListener('visibilitychange', this._clearMoveInput);
        for (const [eventName, handler] of this._canvasListeners) {
            this._canvas.removeEventListener(eventName, handler);
        }
        this._canvasListeners.length = 0;
        this._inputModeTracker.detach();
        this._modeShortcuts.detach();
        this._pointerLock.detach();
        this._navInteraction.detach();
        this._gamepad.detach();
        this._touch.detach();
        this._keyboardMouse.detach();
        this._trackpad.detach();
    }
    update(dt, distance) {
        const { state } = this._global;
        const cameraComponent = this._global.camera.camera;
        const isOrbit = state.cameraMode === 'orbit';
        const isFly = state.cameraMode === 'fly';
        const isWalk = state.cameraMode === 'walk';
        const isFirstPerson = isFly || isWalk;
        const ctx = {
            dt,
            distance,
            cameraComponent,
            mode: state.cameraMode,
            isOrbit,
            isFly,
            isWalk,
            isFirstPerson,
            gamingControls: state.gamingControls,
            // Touch must update first so the count is current; the running
            // count is also used by the keyboard-mouse pan flag.
            touchCount: this._touch.touchCount
        };
        // order: touch first (so touchCount in ctx reflects this frame's
        // count delta), then everyone else.
        this._touch.update(ctx, this.frame);
        ctx.touchCount = this._touch.touchCount;
        this._keyboardMouse.update(ctx, this.frame);
        this._trackpad.update(ctx, this.frame);
        this._gamepad.update(ctx, this.frame);
        if (isFirstPerson && (this._moveInput[0] !== 0 || this._moveInput[1] !== 0)) {
            this._global.events.fire('navigateCancel');
            const speed = this.moveSpeed * dt;
            this.frame.deltas.move.append([this._moveInput[0] * speed, 0, this._moveInput[1] * speed]);
        }
    }
}

// Single-layer overlay rendered after the gaussians, three passes on a fresh
// depth buffer:
//
//   1. Surface depth pre-pass: color writes masked off, depth test/write on.
//      Stamps the front-most surface depth into the depth buffer.
//   2. Surface color pass: depthFunc EQUAL, depth write off, vertex-color
//      tinted via StandardMaterial. Only the front-most fragment from pass 1
//      survives so a single layer of semi-transparent surface color blends
//      onto the camera target.
//   3. Wireframe pass: opaque-looking black lines (RENDERSTYLE_WIREFRAME),
//      depth-tested against the surface depth so back-facing edges are
//      hidden.
//
// All three passes use BLEND_NORMAL so they share the layer's *transparent*
// render action. PlayCanvas creates separate opaque and transparent render
// actions per layer and `clearDepthBuffer` clears the depth buffer for each
// of them — if the depth pre-pass were opaque, the transparent action would
// wipe the depth before pass 2 and FUNC_EQUAL would always fail.
// Linear gray levels picked by dominant face axis, plus the surface alpha.
// These values are what we want the framebuffer to actually contain — pre-
// encoding below makes that true regardless of the gamma path taken.
const SURFACE_GRAY_X = 0.85;
const SURFACE_GRAY_Y = 0.55;
const SURFACE_GRAY_Z = 0.3;
const SURFACE_ALPHA = 0.3;
// Build an unindexed mesh where every triangle has three unique vertices that
// share the triangle's flat face color (tint by dominant axis of the face
// normal, alpha baked in). Per-triangle vertices give the surface a faceted
// look matching the voxel overlay.
//
// `cameraFrameEnabled` controls how the per-vertex color is encoded so the
// overlay looks identical between the WebGL (no CameraFrame) and
// WebGPU (CameraFrame) paths. With CameraFrame on, the engine's
// `gammaCorrectOutput` is a no-op (GAMMA_NONE) and the StandardMaterial
// output lands in the framebuffer as-is — so we feed the raw gray value.
// Without CameraFrame, `gammaCorrectOutput` applies `pow(1/2.2)` to the
// material output, so we feed `pow(gray, 2.2)` here and gamma-correct
// undoes it; the framebuffer ends up storing the same raw gray value.
// Encode the per-triangle gray + alpha into a flat Uint8 RGBA color stream
// (one entry per unwelded vertex, three vertices per triangle). Reuses an
// existing buffer if one is provided so colors can be re-baked when the
// CameraFrame state toggles at runtime (e.g. XR start/end).
const encodeFlatColors = (tris, cameraFrameEnabled, out) => {
    const encode = (v) => Math.round((cameraFrameEnabled ? v : Math.pow(v, 2.2)) * 255);
    const grayX = encode(SURFACE_GRAY_X);
    const grayY = encode(SURFACE_GRAY_Y);
    const grayZ = encode(SURFACE_GRAY_Z);
    const alpha = Math.round(SURFACE_ALPHA * 255);
    const numTris = tris.count;
    const colors = out ?? new Uint8Array(numTris * 12);
    for (let i = 0; i < numTris; i++) {
        const ax = Math.abs(tris.nx[i]);
        const ay = Math.abs(tris.ny[i]);
        const az = Math.abs(tris.nz[i]);
        let gray;
        if (ax > ay && ax > az) {
            gray = grayX;
        }
        else if (ay > az) {
            gray = grayY;
        }
        else {
            gray = grayZ;
        }
        const oc = i * 12;
        for (let j = 0; j < 3; j++) {
            const k = oc + j * 4;
            colors[k] = gray;
            colors[k + 1] = gray;
            colors[k + 2] = gray;
            colors[k + 3] = alpha;
        }
    }
    return colors;
};
const buildFlatMesh = (tris, cameraFrameEnabled) => {
    const numTris = tris.count;
    const flatPositions = new Float32Array(numTris * 9);
    const flatColors = encodeFlatColors(tris, cameraFrameEnabled);
    const flatIndices = new Uint32Array(numTris * 3);
    for (let i = 0; i < numTris; i++) {
        const op = i * 9;
        flatPositions[op] = tris.v0x[i];
        flatPositions[op + 1] = tris.v0y[i];
        flatPositions[op + 2] = tris.v0z[i];
        flatPositions[op + 3] = tris.v1x[i];
        flatPositions[op + 4] = tris.v1y[i];
        flatPositions[op + 5] = tris.v1z[i];
        flatPositions[op + 6] = tris.v2x[i];
        flatPositions[op + 7] = tris.v2y[i];
        flatPositions[op + 8] = tris.v2z[i];
        const oi = i * 3;
        flatIndices[oi] = oi;
        flatIndices[oi + 1] = oi + 1;
        flatIndices[oi + 2] = oi + 2;
    }
    return { flatPositions, flatColors, flatIndices };
};
// Configures a StandardMaterial that emits the per-vertex color directly. The
// depth pre-pass and the color pass use the same configuration (so they
// compile to identical shaders and produce bit-identical depth values for
// FUNC_EQUAL); only their write masks and depth state differ.
const makeSurfaceMaterial = () => {
    const m = new StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.useFog = false;
    m.useTonemap = false;
    m.ambient = new Color(0, 0, 0);
    m.diffuse = new Color(0, 0, 0);
    m.specular = new Color(0, 0, 0);
    m.emissive = new Color(1, 1, 1);
    m.emissiveVertexColor = true;
    m.emissiveVertexColorChannel = 'rgb';
    m.opacityVertexColor = true;
    m.opacityVertexColorChannel = 'a';
    m.opacity = 1;
    return m;
};
class MeshDebugOverlay {
    app;
    camera;
    layer;
    entity;
    mesh;
    triangles;
    flatColors;
    materials;
    _enabled = false;
    constructor(app, collision, camera, cameraFrameEnabled) {
        this.app = app;
        this.camera = camera;
        this.triangles = collision.triangles;
        const device = app.graphicsDevice;
        const { flatPositions, flatColors, flatIndices } = buildFlatMesh(this.triangles, cameraFrameEnabled);
        this.flatColors = flatColors;
        const mesh = new Mesh(device);
        mesh.setPositions(flatPositions);
        mesh.setColors32(flatColors);
        mesh.setIndices(flatIndices);
        mesh.update(PRIMITIVE_TRIANGLES);
        mesh.generateWireframe();
        this.mesh = mesh;
        this.layer = new Layer({
            name: 'CollisionOverlay',
            enabled: false,
            clearColorBuffer: false,
            clearDepthBuffer: true,
            opaqueSortMode: SORTMODE_MANUAL,
            transparentSortMode: SORTMODE_MANUAL
        });
        app.scene.layers.push(this.layer);
        camera.camera.layers = [...camera.camera.layers, this.layer.id];
        // Pass 1: depth pre-pass. Color writes masked off so only depth lands
        // in the buffer. Both this and pass 2 use the same depthBias /
        // slopeDepthBias so they write/test identical depth values
        // (FUNC_EQUAL relies on this) while still sitting slightly behind the
        // wireframe lines so pass 3's FUNC_LESSEQUAL passes reliably without
        // z-fighting.
        const depthMaterial = makeSurfaceMaterial();
        depthMaterial.cull = CULLFACE_BACK;
        depthMaterial.blendType = BLEND_NORMAL;
        depthMaterial.depthTest = true;
        depthMaterial.depthWrite = true;
        depthMaterial.depthBias = 1;
        depthMaterial.slopeDepthBias = 1;
        depthMaterial.redWrite = false;
        depthMaterial.greenWrite = false;
        depthMaterial.blueWrite = false;
        depthMaterial.alphaWrite = false;
        depthMaterial.update();
        const depthInstance = new MeshInstance(mesh, depthMaterial);
        depthInstance.drawOrder = 0;
        const depthEntity = new Entity('CollisionDepthPrepass', this.app);
        depthEntity.addComponent('render', {
            meshInstances: [depthInstance],
            layers: [this.layer.id]
        });
        // Pass 2: surface color, depth EQUAL. Only the front-most fragment
        // from pass 1 survives, so a single layer of vertex color blends onto
        // the camera target.
        const surfaceMaterial = makeSurfaceMaterial();
        surfaceMaterial.cull = CULLFACE_BACK;
        surfaceMaterial.blendType = BLEND_NORMAL;
        surfaceMaterial.depthTest = true;
        surfaceMaterial.depthFunc = FUNC_EQUAL;
        surfaceMaterial.depthWrite = false;
        surfaceMaterial.depthBias = 1;
        surfaceMaterial.slopeDepthBias = 1;
        surfaceMaterial.update();
        const surfaceInstance = new MeshInstance(mesh, surfaceMaterial);
        surfaceInstance.drawOrder = 1;
        const surfaceEntity = new Entity('CollisionSurface', this.app);
        surfaceEntity.addComponent('render', {
            meshInstances: [surfaceInstance],
            layers: [this.layer.id]
        });
        // Pass 3: wireframe — black lines depth-tested against the surface so
        // back-facing edges are hidden. BLEND_NORMAL with opacity = 1 looks
        // opaque but routes through the same transparent render action as the
        // other two passes, keeping all three under one depth clear.
        const wireframeMaterial = new StandardMaterial();
        wireframeMaterial.useLighting = false;
        wireframeMaterial.useSkybox = false;
        wireframeMaterial.useFog = false;
        wireframeMaterial.useTonemap = false;
        wireframeMaterial.ambient = new Color(0, 0, 0);
        wireframeMaterial.diffuse = new Color(0, 0, 0);
        wireframeMaterial.specular = new Color(0, 0, 0);
        wireframeMaterial.emissive = new Color(0, 0, 0);
        wireframeMaterial.opacity = 1;
        wireframeMaterial.blendType = BLEND_NORMAL;
        wireframeMaterial.depthTest = true;
        wireframeMaterial.depthFunc = FUNC_LESSEQUAL;
        wireframeMaterial.depthWrite = false;
        wireframeMaterial.cull = CULLFACE_NONE;
        wireframeMaterial.update();
        const wireframeInstance = new MeshInstance(mesh, wireframeMaterial);
        wireframeInstance.drawOrder = 2;
        const wireframeEntity = new Entity('CollisionWireframe', this.app);
        wireframeEntity.addComponent('render', {
            meshInstances: [wireframeInstance],
            layers: [this.layer.id]
        });
        wireframeEntity.render.renderStyle = RENDERSTYLE_WIREFRAME;
        this.materials = [depthMaterial, surfaceMaterial, wireframeMaterial];
        this.entity = new Entity('MeshCollisionDebug', this.app);
        this.entity.addChild(depthEntity);
        this.entity.addChild(surfaceEntity);
        this.entity.addChild(wireframeEntity);
        this.entity.enabled = false;
        app.root.addChild(this.entity);
    }
    set enabled(value) {
        this._enabled = value;
        this.entity.enabled = value;
        // Disable the layer too — otherwise its render actions still execute
        // each frame and the per-layer `clearDepthBuffer` would wipe depth
        // even when no overlay meshes are submitted.
        this.layer.enabled = value;
    }
    get enabled() {
        return this._enabled;
    }
    /**
     * Re-bake and re-upload the per-vertex colors so the overlay stays
     * correct if CameraFrame is destroyed or recreated at runtime (the
     * gamma path differs between the two states).
     *
     * @param cameraFrameEnabled - whether CameraFrame is currently active.
     */
    setCameraFrameEnabled(cameraFrameEnabled) {
        encodeFlatColors(this.triangles, cameraFrameEnabled, this.flatColors);
        this.mesh.setColors32(this.flatColors);
        this.mesh.update(PRIMITIVE_TRIANGLES);
    }
    destroy() {
        // Entity.destroy() removes child entities and tears down their render
        // components, which destroy the MeshInstances and decref the shared
        // Mesh (the last decref destroys its GPU buffers). Materials are not
        // owned by MeshInstance so destroy them explicitly here.
        this.entity?.destroy();
        for (const m of this.materials)
            m.destroy();
        this.materials.length = 0;
        this.app.scene.layers.remove(this.layer);
        this.camera.camera.layers = this.camera.camera.layers.filter((id) => id !== this.layer.id);
    }
}

const SVGNS = 'http://www.w3.org/2000/svg';
const NUM_SAMPLES = 12;
const BASE_OUTER_RADIUS = 0.2;
const INNER_OUTER_RATIO = 0.17 / 0.2;
// Screen-space diameter (in CSS pixels) used for both hover and target
// rings when the scene isn't walk-sized. Walk-sized scenes render
// world-space (BASE_OUTER_RADIUS) so the ring orients to the surface and
// reads as a physical footprint; smaller scenes (or no collision) fall
// back to a fixed pixel size, which keeps the ring legible when 0.2 world
// units would eat too much of the scene. Selection happens in
// screenPixelsForRing(), keyed on state.walkAllowed.
const SCREEN_OUTER_PIXELS = 48;
const BEZIER_K = 1 / 6;
const NORMAL_SMOOTH_FACTOR = 0.25;
const NORMAL_SNAP_ANGLE = Math.PI / 4;
const NORMAL_EPSILON = 1e-6;
const createNormalSnapDirections = () => {
    const result = [];
    for (let pitchStep = -2; pitchStep <= 2; pitchStep++) {
        const pitch = pitchStep * NORMAL_SNAP_ANGLE;
        const cp = Math.cos(pitch);
        const sy = Math.sin(pitch);
        if (Math.abs(cp) <= NORMAL_EPSILON) {
            result.push(new Vec3(0, sy > 0 ? 1 : -1, 0));
            continue;
        }
        for (let yawStep = 0; yawStep < 8; yawStep++) {
            const yaw = yawStep * NORMAL_SNAP_ANGLE;
            result.push(new Vec3(Math.cos(yaw) * cp, sy, Math.sin(yaw) * cp));
        }
    }
    return result;
};
const NORMAL_SNAP_DIRECTIONS = createNormalSnapDirections();
const snapNormal = (nx, ny, nz, out) => {
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len <= NORMAL_EPSILON) {
        return out.set(0, 1, 0);
    }
    const invLen = 1 / len;
    const x = nx * invLen;
    const y = ny * invLen;
    const z = nz * invLen;
    let best = NORMAL_SNAP_DIRECTIONS[0];
    let bestDot = -Infinity;
    for (let i = 0; i < NORMAL_SNAP_DIRECTIONS.length; i++) {
        const candidate = NORMAL_SNAP_DIRECTIONS[i];
        const dot = candidate.x * x + candidate.y * y + candidate.z * z;
        if (dot > bestDot) {
            bestDot = dot;
            best = candidate;
        }
    }
    return out.copy(best);
};
const tmpV = new Vec3();
const tmpScreen = new Vec3();
const tangent = new Vec3();
const bitangent = new Vec3();
const worldPt = new Vec3();
const up = new Vec3(0, 1, 0);
const right = new Vec3(1, 0, 0);
// Compute the world-space radius such that a circle at `pos` projects to a
// ring of `pixelDiameter` on screen. Used by the no-collision sizing path
// (see screenPixelsForRing) to keep a constant on-screen diameter
// regardless of camera distance.
const worldRadiusForPixels = (camera, canvasHeight, pos, pixelDiameter) => {
    const cam = camera.camera;
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return (pixelDiameter * cam.orthoHeight) / canvasHeight;
    }
    const camPos = camera.getPosition();
    const dx = pos.x - camPos.x;
    const dy = pos.y - camPos.y;
    const dz = pos.z - camPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const halfFovTan = Math.tan((cam.fov * Math.PI) / 360);
    return (pixelDiameter * distance * halfFovTan) / canvasHeight;
};
const buildBezierRing = (sx, sy) => {
    const n = sx.length;
    let p = `M${sx[0].toFixed(1)},${sy[0].toFixed(1)}`;
    for (let i = 0; i < n; i++) {
        const i0 = (i - 1 + n) % n;
        const i1 = i;
        const i2 = (i + 1) % n;
        const i3 = (i + 2) % n;
        const cp1x = sx[i1] + (sx[i2] - sx[i0]) * BEZIER_K;
        const cp1y = sy[i1] + (sy[i2] - sy[i0]) * BEZIER_K;
        const cp2x = sx[i2] - (sx[i3] - sx[i1]) * BEZIER_K;
        const cp2y = sy[i2] - (sy[i3] - sy[i1]) * BEZIER_K;
        p += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${sx[i2].toFixed(1)},${sy[i2].toFixed(1)}`;
    }
    return `${p} Z`;
};
class CursorRing {
    path;
    svg;
    canvas;
    camera;
    smoothing;
    smoothNx = 0;
    smoothNy = 1;
    smoothNz = 0;
    hasSmoothedNormal = false;
    outerX = new Float64Array(NUM_SAMPLES);
    outerY = new Float64Array(NUM_SAMPLES);
    innerX = new Float64Array(NUM_SAMPLES);
    innerY = new Float64Array(NUM_SAMPLES);
    constructor(svg, canvas, camera, smoothing) {
        this.svg = svg;
        this.canvas = canvas;
        this.camera = camera;
        this.smoothing = smoothing;
        this.path = document.createElementNS(SVGNS, 'path');
        this.path.setAttribute('fill', 'white');
        this.path.setAttribute('fill-opacity', '0.6');
        this.path.setAttribute('fill-rule', 'evenodd');
        this.path.setAttribute('stroke', 'none');
        this.path.style.display = 'none';
        svg.appendChild(this.path);
    }
    projectCircle(px, py, pz, nx, ny, nz, radius, outX, outY) {
        const normal = tmpV.set(nx, ny, nz);
        if (Math.abs(normal.y) < 0.99) {
            tangent.cross(normal, up).normalize();
        }
        else {
            tangent.cross(normal, right).normalize();
        }
        bitangent.cross(normal, tangent);
        const cam = this.camera.camera;
        const angleStep = (2 * Math.PI) / NUM_SAMPLES;
        for (let i = 0; i < NUM_SAMPLES; i++) {
            const theta = i * angleStep;
            const ct = Math.cos(theta);
            const st = Math.sin(theta);
            const tx = ct * tangent.x + st * bitangent.x;
            const ty = ct * tangent.y + st * bitangent.y;
            const tz = ct * tangent.z + st * bitangent.z;
            worldPt.set(px + tx * radius, py + ty * radius, pz + tz * radius);
            cam.worldToScreen(worldPt, tmpScreen);
            outX[i] = tmpScreen.x;
            outY[i] = tmpScreen.y;
        }
    }
    // screenPixels: null → world-space ring (fixed world radius, shrinks
    // with distance); number → constant on-screen diameter in CSS pixels.
    render(pos, normal, screenPixels) {
        snapNormal(normal.x, normal.y, normal.z, tmpV);
        let nx = tmpV.x;
        let ny = tmpV.y;
        let nz = tmpV.z;
        if (this.smoothing) {
            if (this.hasSmoothedNormal) {
                const t = NORMAL_SMOOTH_FACTOR;
                nx = this.smoothNx + (nx - this.smoothNx) * t;
                ny = this.smoothNy + (ny - this.smoothNy) * t;
                nz = this.smoothNz + (nz - this.smoothNz) * t;
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 1e-6) {
                    const invLen = 1.0 / len;
                    nx *= invLen;
                    ny *= invLen;
                    nz *= invLen;
                }
            }
            this.smoothNx = nx;
            this.smoothNy = ny;
            this.smoothNz = nz;
            this.hasSmoothedNormal = true;
        }
        const outerRadius = screenPixels !== null
            ? worldRadiusForPixels(this.camera, this.canvas.clientHeight || 1, pos, screenPixels)
            : BASE_OUTER_RADIUS;
        const innerRadius = outerRadius * INNER_OUTER_RATIO;
        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, outerRadius, this.outerX, this.outerY);
        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, innerRadius, this.innerX, this.innerY);
        this.path.setAttribute('d', `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`);
        this.path.style.display = '';
        this.svg.style.display = '';
    }
    hide() {
        this.path.style.display = 'none';
        this.hasSmoothedNormal = false;
    }
}
class NavCursor {
    svg;
    captureMarker;
    hoverRing;
    targetRing;
    camera;
    // Settable after construction: the viewer reveals the scene before the collision data has
    // downloaded, so this arrives late. Ring sizing reads `state.walkAllowed` live, so only the
    // pick path needs updating here.
    collision;
    canvas;
    state;
    app;
    onPrerender;
    // True when the hover ring should track the pointer. Only walk mode
    // (with mouse navigation, not gaming controls) shows the hover ring;
    // fly/orbit only show the target ring on click.
    hoverActive = false;
    navigating = false;
    targetPos = null;
    targetNormal = null;
    targetMode = null;
    onPointerMove;
    onPointerLeave;
    collisionTarget = {
        position: new Vec3(),
        normal: new Vec3()
    };
    constructor(app, camera, collision, events, state, reticle) {
        this.camera = camera;
        this.collision = collision;
        this.canvas = app.graphicsDevice.canvas;
        this.state = state;
        this.app = app;
        this.svg = document.createElementNS(SVGNS, 'svg');
        this.svg.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible';
        // in the scene layer, over the scene and beneath the ui, and first in it so the
        // annotations draw over the cursor
        const parent = this.canvas.parentElement;
        (parent.querySelector(':scope > .sse-sceneLayer') ?? parent).prepend(this.svg);
        this.captureMarker = document.createElementNS(SVGNS, 'circle');
        this.captureMarker.setAttribute('cx', '50%');
        this.captureMarker.setAttribute('cy', '50%');
        this.captureMarker.setAttribute('r', '2');
        this.captureMarker.setAttribute('fill', 'white');
        this.captureMarker.setAttribute('stroke', 'black');
        this.captureMarker.setAttribute('stroke-opacity', '0.5');
        this.captureMarker.setAttribute('stroke-width', '2');
        this.captureMarker.style.display = 'none';
        this.svg.appendChild(this.captureMarker);
        this.hoverRing = new CursorRing(this.svg, this.canvas, camera, true);
        this.targetRing = new CursorRing(this.svg, this.canvas, camera, false);
        this.svg.style.display = 'none';
        this.onPointerMove = (e) => {
            if (e.pointerType === 'touch' || e.buttons) {
                this.hoverRing.hide();
                return;
            }
            this.updateCursor(e.offsetX, e.offsetY);
        };
        this.onPointerLeave = () => {
            this.hoverRing.hide();
        };
        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerleave', this.onPointerLeave);
        const updateActive = () => {
            const captureActive = reticle &&
                state.inputMode === 'desktop' &&
                state.gamingControls &&
                (state.cameraMode === 'walk' || state.cameraMode === 'fly');
            this.captureMarker.style.display = captureActive ? '' : 'none';
            if (captureActive) {
                this.svg.style.display = '';
            }
            // Hover ring only in walk mode with mouse navigation. Gaming
            // controls use pointer-lock and don't need a hover preview.
            this.hoverActive = state.cameraMode === 'walk' && !state.gamingControls;
            this.hoverRing.hide();
            if (this.targetMode && this.targetMode !== state.cameraMode) {
                this.navigating = false;
                this.clearTarget();
            }
        };
        events.on('cameraMode:changed', updateActive);
        events.on('inputMode:changed', updateActive);
        events.on('gamingControls:changed', updateActive);
        events.on('navigateTo', () => {
            this.navigating = true;
            this.hoverRing.hide();
        });
        events.on('navigateCancel', () => {
            this.navigating = false;
            this.clearTarget();
        });
        events.on('navigateComplete', () => {
            this.navigating = false;
            this.clearTarget();
        });
        events.on('navTarget:set', (pos, normal) => {
            const mode = state.cameraMode === 'walk' || state.cameraMode === 'fly' ? state.cameraMode : 'walk';
            this.setTarget(pos, normal, mode);
        });
        events.on('navTarget:clear', () => {
            this.clearTarget();
        });
        events.on('orbitTarget:set', (pos, normal) => {
            this.navigating = false;
            this.setTarget(pos, normal, 'orbit');
        });
        events.on('orbitTarget:clear', () => {
            if (this.targetMode === 'orbit') {
                this.clearTarget();
            }
        });
        this.onPrerender = () => {
            this.updateTarget();
        };
        app.on('prerender', this.onPrerender);
        updateActive();
    }
    // Ring sizing is per-scene: walk-sized scenes (collision present and
    // bbox large enough — same predicate as walk mode) get world-space
    // rings, which read as physical footprints on the surface with visible
    // orientation. Smaller scenes or scenes without collision use a fixed
    // screen-pixel ring — 0.2 world units would dominate a small scene,
    // and the pick already falls back to splat depth without collision.
    screenPixelsForRing() {
        return this.state.walkAllowed ? null : SCREEN_OUTER_PIXELS;
    }
    setTarget(pos, normal, mode) {
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
        this.targetMode = mode;
        this.hoverRing.hide();
        this.targetRing.hide();
    }
    clearTarget() {
        this.targetPos = null;
        this.targetNormal = null;
        this.targetMode = null;
        this.targetRing.hide();
    }
    pickCollision(offsetX, offsetY) {
        if (!this.collision) {
            return null;
        }
        const { camera, collision } = this;
        const cameraPos = camera.getPosition();
        camera.camera.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();
        const hit = collision.queryRay(cameraPos.x, cameraPos.y, cameraPos.z, tmpV.x, tmpV.y, tmpV.z, camera.camera.farClip);
        if (!hit) {
            return null;
        }
        const sn = collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV.x, tmpV.y, tmpV.z);
        this.collisionTarget.position.set(hit.x, hit.y, hit.z);
        this.collisionTarget.normal.set(sn.nx, sn.ny, sn.nz);
        return this.collisionTarget;
    }
    updateCursor(offsetX, offsetY) {
        if (!this.hoverActive || this.navigating) {
            this.hoverRing.hide();
            return;
        }
        const target = this.pickCollision(offsetX, offsetY);
        if (!target) {
            this.hoverRing.hide();
            return;
        }
        this.hoverRing.render(target.position, target.normal, this.screenPixelsForRing());
    }
    updateTarget() {
        if (!this.targetPos || !this.targetNormal || !this.targetMode) {
            return;
        }
        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (this.targetMode !== 'orbit' && dist < 2.0) {
            this.targetRing.hide();
            return;
        }
        this.targetRing.render(this.targetPos, this.targetNormal, this.screenPixelsForRing());
    }
    destroy() {
        this.app.off('prerender', this.onPrerender);
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.svg.remove();
    }
}

/**
 * World picking from the stochastic renderer's own frame.
 *
 * Every pixel of that renderer's depth texture holds the nearest surviving sample, which is
 * exactly what the pass picker in `picker.ts` renders on purpose: a stochastic depth whose
 * distribution over a disc is the scene's opacity along the ray. So no pick pass: the frame's
 * depth is snapshotted into the same encoding (normalised linear depth in four half-float
 * channels, 1 where nothing survived) at css resolution, and the shared estimators, the
 * annotation test and the debug overlay read it unchanged. A css pixel's four channels are four
 * of the device pixels it covers, so a high-density display supplies four trials as before.
 */
// The frame's hardware depth as normalised linear view depth, in the pass picker's encoding.
// Each snapshot pixel covers a block of device pixels; four of them, at the block's quarter
// points, fill the four channels.
const snapshotWgsl = /* wgsl */ `
var splatDepth: texture_depth_2d;
// clip z = a * viewDepth + b over w = viewDepth (x, y), near and far (z, w)
uniform depthViewParams: vec4f;
// device pixels per snapshot pixel (x, y), 1 for an orthographic camera (z)
uniform snapshotParams: vec4f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let dims = vec2i(textureDimensions(splatDepth));
    let p = uniform.depthViewParams;
    let ortho = uniform.snapshotParams.z > 0.5;
    let origin = floor(pcPosition.xy);
    var trials = vec4f(1.0);
    for (var i = 0; i < 4; i++) {
        let corner = vec2f(0.25 + 0.5 * f32(i & 1), 0.25 + 0.5 * f32(i >> 1));
        let q = clamp(vec2i(floor((origin + corner) * uniform.snapshotParams.xy)), vec2i(0), dims - vec2i(1));
        let depth = textureLoad(splatDepth, q, 0);
        if (depth < 1.0) {
            let dz = depth - p.x;
            let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
            let viewDepth = select(p.y / safeDz, (depth - p.y) / p.x, ortho);
            trials[i] = clamp((viewDepth - p.z) / (p.w - p.z), 0.0, 0.99951171875);
        }
    }
    output.color = trials;
    return output;
}
`;
const cameraMatches = (frame, camera) => {
    const cam = camera.camera;
    return (frame.viewMatrix.equals(cam.viewMatrix) &&
        frame.projectionMatrix.equals(cam.projectionMatrix) &&
        frame.nearClip === cam.nearClip &&
        frame.farClip === cam.farClip &&
        frame.projection === cam.projection);
};
const sameCamera = (a, b) => a.viewMatrix.equals(b.viewMatrix) &&
    a.projectionMatrix.equals(b.projectionMatrix) &&
    a.nearClip === b.nearClip &&
    a.farClip === b.farClip &&
    a.projection === b.projection;
const copyCameraSnapshot = (from, to) => {
    to.position.copy(from.position);
    to.viewMatrix.copy(from.viewMatrix);
    to.projectionMatrix.copy(from.projectionMatrix);
    to.nearClip = from.nearClip;
    to.farClip = from.farClip;
    to.projection = from.projection;
};
class FrameDepthPicker {
    app;
    camera;
    renderer;
    shader;
    texture = null;
    target = null;
    // the renderer frame the snapshot was taken from, and the camera it was drawn with
    snapshotFrame = -1;
    snapshotCamera = createPickCameraSnapshot();
    renders = 0;
    queue = new PickQueue();
    // picks waiting for a frame to render; settled by release as well
    waiters = new Set();
    constructor(app, camera, renderer) {
        this.app = app;
        this.camera = camera;
        this.renderer = renderer;
        this.shader = ShaderUtils.createShader(app.graphicsDevice, {
            uniqueName: 'sse-splat-depth-snapshot',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentWGSL: snapshotWgsl
        });
    }
    // Wait for the next frame to finish, or for release.
    nextFrame() {
        return new Promise((resolve) => {
            const done = () => {
                handle.off();
                this.waiters.delete(done);
                resolve();
            };
            const handle = this.app.once('frameend', done);
            this.waiters.add(done);
        });
    }
    // Snapshot the renderer's frame at css resolution, unless the snapshot already is of it. With
    // `latest` false a snapshot of an earlier frame from the same camera serves: every stochastic
    // frame is a new sample, so the debug overlay would otherwise ask for frames without end.
    snapshot(frame, latest) {
        const device = this.app.graphicsDevice;
        const size = pickTargetSize(device);
        if (!size)
            return null;
        const { width, height } = size;
        if (!this.texture) {
            this.texture = new Texture(device, {
                name: 'sse-splat-depth-snapshot',
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            this.target = new RenderTarget({
                name: 'sse-splat-depth-snapshot',
                colorBuffer: this.texture,
                depth: false
            });
            this.snapshotFrame = -1;
        }
        else if (this.texture.width !== width || this.texture.height !== height) {
            this.target.resize(width, height);
            this.snapshotFrame = -1;
        }
        const current = this.snapshotFrame === frame.id ||
            (!latest && this.snapshotFrame >= 0 && sameCamera(this.snapshotCamera, frame.camera));
        if (!current) {
            const { scope } = device;
            const { camera } = frame;
            scope.resolve('splatDepth').setValue(this.renderer.frameDepthTexture);
            scope
                .resolve('depthViewParams')
                .setValue([frame.clipZ[0], frame.clipZ[1], camera.nearClip, camera.farClip]);
            scope
                .resolve('snapshotParams')
                .setValue([
                frame.width / width,
                frame.height / height,
                camera.projection === PROJECTION_ORTHOGRAPHIC ? 1 : 0,
                0
            ]);
            device.setBlendState(BlendState.NOBLEND);
            drawQuadWithShader(device, this.target, this.shader);
            this.snapshotFrame = frame.id;
            copyCameraSnapshot(frame.camera, this.snapshotCamera);
            this.renders++;
        }
        // the renderer rewrites its snapshot every frame, and frames render while a pick awaits
        // its readback: the pick unprojects with a copy of the camera its depth was drawn with
        const pickCamera = createPickCameraSnapshot();
        copyCameraSnapshot(frame.camera, pickCamera);
        return { width, height, pickCamera };
    }
    // The frame to pick from: the last one rendered if the camera has not moved since, else
    // one requested now. Its own camera unprojects it, whatever the live camera does meanwhile.
    async prepare() {
        if (this.queue.released)
            return null;
        let frame = this.renderer.depthFrame;
        if (!frame || !cameraMatches(frame.camera, this.camera)) {
            this.app.renderNextFrame = true;
            await this.nextFrame();
            frame = this.renderer.depthFrame;
            if (!frame || this.queue.released)
                return null;
        }
        return this.snapshot(frame, true);
    }
    // Read the snapshot around a pixel, `margin` pixels each way, clamped to it.
    async readAround(screenX, screenY, margin, width, height) {
        const blockX = Math.max(0, screenX - margin);
        const blockY = Math.max(0, screenY - margin);
        const blockWidth = Math.min(width - 1, screenX + margin) - blockX + 1;
        const blockHeight = Math.min(height - 1, screenY + margin) - blockY + 1;
        const pixels = (await this.texture.read(blockX, blockY, blockWidth, blockHeight, {
            renderTarget: this.target,
            immediate: true
        }));
        return (x, y, trial) => {
            const localX = x - blockX;
            const localY = y - blockY;
            if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                return null;
            }
            return half2Float(pixels[(localY * blockWidth + localX) * 4 + trial]);
        };
    }
    pick(x, y) {
        return this.queue.run(async () => {
            const sample = await this.prepare();
            if (!sample)
                return null;
            const { width, height, pickCamera } = sample;
            const screenX = clampPixel(x, width);
            const screenY = clampPixel(y, height);
            const depthAt = await this.readAround(screenX, screenY, SURFACE_RADIUS_PX, width, height);
            const depth = surfaceDepth(depthAt, screenX, screenY);
            return depth === null ? null : getWorldPoint(pickCamera, screenX, screenY, width, height, depth);
        }, null);
    }
    pickSurface(x, y) {
        return this.queue.run(async () => {
            const sample = await this.prepare();
            if (!sample)
                return null;
            const { width, height, pickCamera } = sample;
            const screenX = clampPixel(x, width);
            const screenY = clampPixel(y, height);
            const depthAt = await this.readAround(screenX, screenY, NORMAL_SAMPLE_MAX_PX + SURFACE_RADIUS_PX, width, height);
            return estimateSurface(depthAt, pickCamera, width, height, screenX, screenY);
        }, null);
    }
    pickVisibility(points, radius) {
        if (points.length === 0) {
            return Promise.resolve([]);
        }
        return this.queue.run(async () => {
            const sample = await this.prepare();
            if (!sample)
                return points.map(() => null);
            const { width, height, pickCamera } = sample;
            const r = Math.max(1, Math.round(radius * height));
            return Promise.all(points.map(async ({ x, y, depth }) => {
                const screenX = clampPixel(x, width);
                const screenY = clampPixel(y, height);
                const depthAt = await this.readAround(screenX, screenY, r, width, height);
                return opacityInFront(depthAt, pickCamera, screenX, screenY, r, depth);
            }));
        }, points.map(() => null));
    }
    // The last frame's snapshot, for the debug overlay; it asks after each frame, so the frame
    // is the current camera's.
    renderView() {
        if (this.queue.released)
            return null;
        const frame = this.renderer.depthFrame;
        if (!frame || !this.snapshot(frame, false))
            return null;
        return { texture: this.texture, renders: this.renders };
    }
    release() {
        this.queue.released = true;
        for (const done of [...this.waiters])
            done();
        this.target?.destroy();
        this.texture?.destroy();
        this.target = null;
        this.texture = null;
        this.shader.destroy();
    }
}

// The resident set: which splats the engine's LOD and streaming have made resident this
// frame, and where each node's data sits. The engine keeps octree LOD, the budget, file
// streaming and the block allocator (one slot range per node); the stochastic renderer
// consumes its decisions and owns everything after them.
//
// Read through the engine's internal (@ignore) gsplat-unified classes until the public
// `world:update` api lands (engine change E3 in the plan). Every internal shape used is
// narrowed here to the members this file reads, so a change in the engine fails in one place.
const tmpVec = new Vec3();
const tmpVec2$1 = new Vec3();
/**
 * Hooks the engine's per-frame gsplat update for one camera and layer and exposes the resident
 * set. `frame:ready` fires inside `GSplatManager.update()` after `world.bake()` and after the
 * engine's own render prep (both in 2.22.4 and on main), so a listener sees the baked state of
 * the current frame and can replace that prep.
 */
class EngineResidentSetProvider {
    app;
    camera;
    layer;
    handles = [];
    callbacks = new Set();
    set = null;
    // the engine renderers this provider has switched off, with their original prep function
    takenOver = new Map();
    // while false the engine keeps rendering the splats itself (XR), and the hook stays quiet
    active = true;
    constructor(app, camera, layer) {
        this.app = app;
        this.camera = camera;
        this.layer = layer;
        const system = app.systems.gsplat;
        // fires when a manager is created for a camera and layer, before its first update:
        // the earliest point to switch the engine's own renderer off, so it never allocates
        // its projector, sort and draw resources
        this.handles.push(system.on('material:created', (material, cam, lyr) => {
            if (cam === this.camera && lyr === this.layer && this.active) {
                const manager = this.manager();
                if (manager)
                    this.takeOver(manager);
            }
        }));
        this.handles.push(system.on('frame:ready', (cam, lyr) => {
            if (cam !== this.camera || lyr !== this.layer || !this.active)
                return;
            const manager = this.manager();
            if (!manager)
                return;
            this.takeOver(manager);
            const state = manager.world.currentState;
            if (!state)
                return;
            const changed = !this.set || this.set.version !== state.version;
            if (changed) {
                this.set = buildResidentSet(state);
            }
            for (const cb of this.callbacks) {
                cb(this.set, changed, manager);
            }
        }));
    }
    /** The engine manager for this camera and layer, once the engine has created it. */
    manager() {
        const director = this.app.renderer.gsplatDirector;
        // the director keys its cameras by the scene camera, not the component
        const cameraData = director?.camerasMap.get(this.camera.camera);
        return cameraData?.layersMap.get(this.layer)?.gsplatManager ?? null;
    }
    /** Hand the splats back to the engine's renderer (false), or take them over again (true). */
    setActive(value) {
        if (this.active === value)
            return;
        this.active = value;
        if (value) {
            const manager = this.manager();
            if (manager)
                this.takeOver(manager);
        }
        else {
            this.restore();
        }
    }
    onFrame(cb) {
        this.callbacks.add(cb);
        return () => this.callbacks.delete(cb);
    }
    /**
     * Switch the engine's own splat rendering off for this manager: its render prep returns
     * false (so the hybrid renderer never builds its projector, sorter or cache) and its mesh
     * instance is hidden. The world (LOD, streaming, allocation, the work-buffer copy) keeps
     * running. Reversed by {@link restore}.
     */
    takeOver(manager) {
        const renderer = manager.renderer;
        if (!this.takenOver.has(renderer)) {
            this.takenOver.set(renderer, renderer.prepareRenderView);
            renderer.prepareRenderView = () => false;
        }
        if (renderer.meshInstance)
            renderer.meshInstance.visible = false;
        // The manager's first update runs its render prep before frame:ready fires, and
        // material:created fires before the layer data holds the manager, so the engine's
        // projector, sorter and compaction get allocated once (32 bytes a splat and more).
        // Release them; the engine recreates them lazily if it renders again (XR, restore)
        // or picks through its sorted path.
        for (const key of ['gpuSorter', 'projector', 'intervalCompaction']) {
            const resource = renderer[key];
            if (resource) {
                resource.destroy();
                renderer[key] = null;
            }
        }
    }
    restore() {
        for (const [renderer, original] of this.takenOver) {
            renderer.prepareRenderView = original;
            if (renderer.meshInstance)
                renderer.meshInstance.visible = true;
        }
        this.takenOver.clear();
    }
    destroy() {
        this.restore();
        for (const handle of this.handles)
            handle.off();
        this.handles.length = 0;
        this.callbacks.clear();
        this.set = null;
    }
}
// Flatten the engine world state into files and nodes with world-space bounds.
const buildResidentSet = (state) => {
    const files = [];
    const nodes = [];
    const spheres = [];
    const pushNode = (node, cx, cy, cz, radius) => {
        nodes.push(node);
        spheres.push(cx, cy, cz, radius);
    };
    state.splats.forEach((info, fileIndex) => {
        const modelMatrix = info.node.getWorldTransform().clone();
        const scale = modelMatrix.getScale(tmpVec2$1);
        const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
        const file = {
            fileIndex,
            lodIndex: info.lodIndex,
            nodes: [],
            modelMatrix,
            resource: info.resource
        };
        const numIntervals = info.intervals.length / 2;
        if (numIntervals === 0) {
            // a single-file resource: one range covering it whole, bounded by its aabb
            const node = {
                fileIndex,
                nodeIndex: nodes.length,
                lodIndex: info.lodIndex,
                sourceBase: 0,
                count: info.activeSplats,
                slotBase: info.intervalOffsets[0] ?? 0,
                allocId: info.allocId
            };
            modelMatrix.transformPoint(info.aabb.center, tmpVec);
            const he = info.aabb.halfExtents;
            pushNode(node, tmpVec.x, tmpVec.y, tmpVec.z, he.length() * maxScale);
            file.nodes.push(node);
        }
        else {
            for (let j = 0; j < numIntervals; j++) {
                const start = info.intervals[j * 2];
                const end = info.intervals[j * 2 + 1];
                const nodeIndex = info.intervalNodeIndices[j];
                const node = {
                    fileIndex,
                    nodeIndex: nodes.length,
                    lodIndex: info.lodIndex,
                    sourceBase: start,
                    count: end - start,
                    slotBase: info.intervalOffsets[j] ?? 0,
                    allocId: info.intervalAllocIds[j]
                };
                const sphere = info.octreeNodes?.[nodeIndex]?.boundingSphere;
                if (sphere) {
                    tmpVec.set(sphere.x, sphere.y, sphere.z);
                    modelMatrix.transformPoint(tmpVec, tmpVec);
                    pushNode(node, tmpVec.x, tmpVec.y, tmpVec.z, sphere.w * maxScale);
                }
                else {
                    // no bounds: never culled
                    pushNode(node, 0, 0, 0, Infinity);
                }
                file.nodes.push(node);
            }
        }
        files.push(file);
    });
    return {
        version: state.version,
        activeSplats: state.totalActiveSplats,
        slotCapacity: state.textureSize * state.textureSize,
        fullRebuild: state.fullRebuild,
        changedAllocIds: state.needsUploadIds,
        files,
        nodes,
        nodeSpheres: new Float32Array(spheres)
    };
};

// Single-thread pass turning the projector's survivor count into the indexed indirect draw
// arguments for the raster pass and the indirect dispatch size of the order scatter. Nothing
// comes back to the cpu, so a frame never stalls on the count. Entry layouts match the engine's
// indirect draw buffer (5 u32 per slot) and indirect dispatch buffer (3 u32 per slot).
const argsWGSL = /* wgsl */ `
struct DrawIndexedIndirectArgs {
    indexCount: u32,
    instanceCount: u32,
    firstIndex: u32,
    baseVertex: i32,
    firstInstance: u32
}

struct ArgsUniforms {
    drawSlot: u32,
    indexCount: u32,
    quadsPerInstance: u32,
    dispatchSlot: u32,
    scatterWorkgroupSize: u32
}

@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read_write> indirectDrawArgs: array<DrawIndexedIndirectArgs>;
@group(0) @binding(2) var<storage, read_write> indirectDispatchArgs: array<u32>;
@group(0) @binding(3) var<uniform> uniforms: ArgsUniforms;

@compute @workgroup_size(1)
fn main() {
    let count = counter[0];
    indirectDrawArgs[uniforms.drawSlot] = DrawIndexedIndirectArgs(
        uniforms.indexCount,
        (count + uniforms.quadsPerInstance - 1u) / uniforms.quadsPerInstance,
        0u,
        0,
        0u
    );
    // the scatter: one workgroup per scatterWorkgroupSize survivors, 2D past the 65535 limit
    let groups = (count + uniforms.scatterWorkgroupSize - 1u) / uniforms.scatterWorkgroupSize;
    let x = max(min(groups, 65535u), 1u);
    let base = uniforms.dispatchSlot * 3u;
    indirectDispatchArgs[base] = x;
    indirectDispatchArgs[base + 1u] = (groups + x - 1u) / x;
    indirectDispatchArgs[base + 2u] = 1u;
}
`;

// Temporal accumulation for the stochastic frame. Each frame the raster leaves one sample per
// pixel (a colour where a splat's fragment survived its coverage test, nothing otherwise) and
// the nearest surviving depth; this pass folds it into a per-pixel history of premultiplied
// colour and coverage, so a still camera converges to the expected image over a few hundred
// frames and a moving one keeps most of that history by reprojecting it.
//
// Reprojection uses the sample's own depth: the pixel's world point is carried into the
// previous view and the history is fetched there, clamped to the colours this frame's
// neighbourhood holds so a stale colour cannot survive a disocclusion. A pixel with no sample
// this frame reprojects through the mean depth its own history remembers, so coverage fades out
// where a surface has moved away rather than smearing into the background.
//
// The history is 12 bytes a pixel (24 with the ping-pong). The colour is the running mean as
// 16-bit fixed point: a half float cannot hold it, since its steps in [0.5, 1) are 1 / 2048 and
// the 1 / N step of a 256-sample mean rounds away once a sample lies within 1 / 16 of the mean
// (an error floor of about 5 rms in 8-bit units), while fixed point steps by 1 / 65535
// everywhere, so the same step only rounds away within half an 8-bit level of the mean. The
// depth record is the mean view depth of the pixel's samples and their count in one 32-bit word.
// the most samples the history's count field holds
const TAA_MAX_COUNT = 511;
const taaVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;
// The history's encoding, shared with the compose that reads it
const taaHistoryWGSL = /* wgsl */ `
const TAA_COLOR_SCALE = 65535.0;

fn decodeColor(v: vec4u) -> vec4f {
    return vec4f(v) / TAA_COLOR_SCALE;
}

// premultiplied colour and coverage: coverage in [0, 1] and colour within it (the Catmull-Rom
// fetch over- and undershoots both), rounded to the nearest step
fn encodeColor(c: vec4f) -> vec4u {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4u(round(vec4f(clamp(c.rgb, vec3f(0.0), vec3f(a)), a) * TAA_COLOR_SCALE));
}

struct HistoryInfo {
    depth: f32,
    count: f32
}

// The mean view depth keeps the float's exponent and top 15 mantissa bits, rounded: a relative
// step of 2^-15, which stalls a 256-sample mean only within 0.4 % of the depth (the depth steers
// the reprojection, where that is far below a pixel). The count takes the low 9 bits
fn decodeInfo(v: u32) -> HistoryInfo {
    var info: HistoryInfo;
    info.depth = bitcast<f32>((v >> 9u) << 8u);
    info.count = f32(v & ${TAA_MAX_COUNT}u);
    return info;
}

fn encodeInfo(depth: f32, count: f32) -> u32 {
    let bits = bitcast<u32>(max(depth, 0.0));
    return (((bits + 0x80u) >> 8u) << 9u) | min(u32(count), ${TAA_MAX_COUNT}u);
}
`;
const taaFragmentWGSL = /* wgsl */ `
var curColor: texture_2d<f32>;
var curColorSampler: sampler;
var curDepth: texture_depth_2d;
// premultiplied colour and coverage, unorm16 (decodeColor)
var histColor: texture_2d<u32>;
// the mean view depth of the pixel's samples and their count, in the previous frame's view
// depths (decodeInfo)
var histInfo: texture_2d<u32>;

// the camera's world transform (the inverse view), and its projection's x and y terms: x, y the
// scales, z, w the offsets (the column that multiplies view z for a perspective camera, the
// translation for an orthographic one)
uniform cameraWorld: mat4x4f;
uniform unproject: vec4f;
uniform prevViewProj: mat4x4f;
uniform prevView: mat4x4f;
// clip z = a * viewDepth + b over w = viewDepth (x, y); z: 1 for an orthographic camera
uniform clipZParams: vec4f;
// x: sample cap, y: 1 when the history holds the previous frame, z: 1 when the camera moved
// since that frame, w: the frames the camera has rested, this one included (0 on a frame whose
// resident set changed)
uniform taaParams: vec4f;
// width, height, 1 / width, 1 / height
uniform taaViewport: vec4f;
// x: -1 when the target's rows run bottom-up (an offscreen target), else 1; y: the colour
// clamp width in neighbourhood standard deviations (0: no clamp); z: 1 when the raster's
// thresholds are quad-stratified
uniform taaControl: vec4f;
// x: 1 for a Catmull-Rom history fetch while moving (0: bilinear); y: 1 to reproject through
// the pixel's accumulated mean depth rather than this frame's sample depth; z: image motion in
// pixels a frame that halves the moving sample cap (0: fixed cap)
uniform taaFilter: vec4f;
// 1: write the accumulation state instead of colour (r: count / cap, g: history accepted,
// b: the camera moved since the previous frame)
uniform taaDebug: f32;

${taaHistoryWGSL}

fn viewDepthOf(z: f32) -> f32 {
    let p = uniform.clipZParams;
    let dz = z - p.x;
    let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
    return select(p.y / safeDz, (z - p.y) / p.x, p.z != 0.0);
}

struct Reprojected {
    valid: bool,
    uv: vec2f,
    prevDepth: f32
}

// The previous frame's view depth and texture coordinate of this pixel's point at a view
// depth. The point is built in view space from the depth and the projection's x and y terms,
// then moved by the camera's rigid transform: through the inverse view-projection instead, a
// near plane at 1e-4 of the depth (the viewer's floor once the camera is inside the scene
// bound) leaves a 32-bit float about three digits of the point, a pixel of error that changes
// with every frame's sample depths and shakes the history.
fn reproject(pix: vec2i, viewDepth: f32) -> Reprojected {
    var r: Reprojected;
    let flip = uniform.taaControl.x;
    let uv = (vec2f(pix) + vec2f(0.5)) * uniform.taaViewport.zw;
    let ndc = vec2f(uv.x * 2.0 - 1.0, flip * (1.0 - 2.0 * uv.y));
    let u = uniform.unproject;
    let viewXY = select((ndc + u.zw) * viewDepth, ndc - u.zw, uniform.clipZParams.z != 0.0) / u.xy;
    let world = (uniform.cameraWorld * vec4f(viewXY, -viewDepth, 1.0)).xyz;
    let prevClip = uniform.prevViewProj * vec4f(world, 1.0);
    r.prevDepth = -(uniform.prevView * vec4f(world, 1.0)).z;
    r.valid = prevClip.w > 0.0;
    let prevNdc = prevClip.xy / max(prevClip.w, 1e-9);
    r.uv = vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * flip * 0.5);
    r.valid = r.valid && all(r.uv >= vec2f(0.0)) && all(r.uv <= vec2f(1.0));
    return r;
}

// the premultiplied sample at a texel: its colour where a fragment landed, nothing otherwise
fn sampleAt(pix: vec2i, dims: vec2i) -> vec4f {
    let p = clamp(pix, vec2i(0), dims - vec2i(1));
    let c = textureLoad(curColor, p, 0);
    let z = textureLoad(curDepth, p, 0);
    return select(vec4f(0.0), vec4f(c.rgb, 1.0), c.a > 0.0 && z < 1.0);
}

// The mean of the 2x2 quad's samples, bilinear between quad centres (the compose's resolve of
// the raster's quad-stratified thresholds): four samples a pixel, at a little sharpness, for
// the frames where the history is too short to carry the noise on its own
fn quadSample(pix: vec2i, dims: vec2i) -> vec4f {
    let size = vec2f(dims);
    let u = (vec2f(pix) - vec2f(0.5)) * 0.5;
    let q0 = floor(u);
    let f = u - q0;
    let uv = (q0 * 2.0 + vec2f(1.0)) / size;
    let step = vec2f(2.0) / size;
    let a = textureSampleLevel(curColor, curColorSampler, uv, 0.0);
    let b = textureSampleLevel(curColor, curColorSampler, uv + vec2f(step.x, 0.0), 0.0);
    let c = textureSampleLevel(curColor, curColorSampler, uv + vec2f(0.0, step.y), 0.0);
    let d = textureSampleLevel(curColor, curColorSampler, uv + step, 0.0);
    let m = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    // the raster leaves empty texels transparent black, so the mean is premultiplied coverage
    return vec4f(m.rgb, m.a);
}

fn historyTexel(p: vec2i, dims: vec2i) -> vec4f {
    return decodeColor(textureLoad(histColor, clamp(p, vec2i(0), dims - vec2i(1)), 0));
}

// Catmull-Rom fetch of the history: sharper than bilinear, whose blur compounds over the
// frames a moving history lives. Its lobes over- and undershoot; the encoding clamps both
fn historyCubicAt(uv: vec2f, dims: vec2i) -> vec4f {
    let p = uv * vec2f(dims) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f = p - floor(p);
    let f2 = f * f;
    let f3 = f2 * f;
    // Catmull-Rom weights for taps at -1, 0, 1, 2
    let w0 = -0.5 * f3 + f2 - 0.5 * f;
    let w1 = 1.5 * f3 - 2.5 * f2 + vec2f(1.0);
    let w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    let w3 = 0.5 * f3 - 0.5 * f2;
    let wx = array<f32, 4>(w0.x, w1.x, w2.x, w3.x);
    let wy = array<f32, 4>(w0.y, w1.y, w2.y, w3.y);
    var sum = vec4f(0.0);
    for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
            sum += historyTexel(i0 + vec2i(x - 1, y - 1), dims) * (wx[x] * wy[y]);
        }
    }
    return sum;
}

// bilinear fetch of the history
fn historyAt(uv: vec2f, dims: vec2i) -> vec4f {
    let p = uv * vec2f(dims) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f = p - floor(p);
    let a = historyTexel(i0, dims);
    let b = historyTexel(i0 + vec2i(1, 0), dims);
    let c = historyTexel(i0 + vec2i(0, 1), dims);
    let d = historyTexel(i0 + vec2i(1, 1), dims);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let pix = vec2i(pcPosition.xy);
    let dims = vec2i(textureDimensions(curColor));
    let cur = textureLoad(curColor, pix, 0);
    let z = textureLoad(curDepth, pix, 0);
    let hit = cur.a > 0.0 && z < 1.0;
    let d = viewDepthOf(z);

    let own = decodeInfo(textureLoad(histInfo, pix, 0).x);
    let maxCount = uniform.taaParams.x;
    let historyValid = uniform.taaParams.y > 0.5;
    let moving = uniform.taaParams.z > 0.5;
    // still: this pixel's own sample, so the history converges to full resolution; moving:
    // the quad's four
    var sample = select(vec4f(0.0), vec4f(cur.rgb, 1.0), hit);
    if (moving && uniform.taaControl.z > 0.5) {
        sample = quadSample(pix, dims);
    }

    // Where to look in the history: through this frame's sample, or, with no sample, through
    // the depth this pixel's own history remembers, so an emptied pixel fades rather than
    // holding a stale colour
    var r: Reprojected;
    r.valid = false;
    var carryDepth = 0.0;
    if (!moving) {
        // a resting camera maps every pixel onto itself: the exact texel, not the round trip
        // through the matrices, whose rounding would blur the history a little every frame
        r.valid = true;
        r.uv = (vec2f(pix) + vec2f(0.5)) * uniform.taaViewport.zw;
        r.prevDepth = select(own.depth, d, hit);
        carryDepth = r.prevDepth;
    } else if (uniform.taaFilter.y > 0.5 && own.count > 0.5) {
        // through the depth the pixel's history has settled on: one stochastic sample's depth
        // is one layer of the mixture the history holds, and reprojecting the mixture through
        // a different layer every frame smears it by their parallax
        r = reproject(pix, own.depth);
        carryDepth = own.depth;
    } else if (hit) {
        r = reproject(pix, d);
        carryDepth = d;
    } else if (own.count > 0.5) {
        r = reproject(pix, own.depth);
        carryDepth = own.depth;
    }
    r.valid = r.valid && historyValid;

    var hist = vec4f(0.0);
    var info: HistoryInfo;
    var accepted = false;
    if (r.valid) {
        // at rest the exact texel; moving, a filtered fetch of the reprojected position
        if (!moving) {
            hist = decodeColor(textureLoad(histColor, pix, 0));
            info = own;
        } else {
            if (uniform.taaFilter.x > 0.5) {
                hist = historyCubicAt(r.uv, dims);
            } else {
                hist = historyAt(r.uv, dims);
            }
            info = decodeInfo(textureLoad(histInfo, clamp(vec2i(r.uv * vec2f(dims)), vec2i(0), dims - vec2i(1)), 0).x);
        }
        // a resting camera cannot disocclude anything, so every sample is accepted and the
        // pixel converges; moving, the colour clamp below keeps a disoccluded history out
        accepted = info.count > 0.5;
    }

    var color: vec4f;
    var mean: f32;
    var count: f32;
    if (!accepted) {
        color = sample;
        mean = d;
        count = select(0.0, 1.0, hit);
        // at rest a pixel with no hit yet has still been sampled on every rest frame, so its
        // first hit is one of that many samples: at full weight a rare hit would flash to full
        // coverage, and freeze there once the viewer stops rendering. Its depth is the hit's
        if (hit && !moving && historyValid) {
            count = clamp(uniform.taaParams.w, 1.0, maxCount);
            color = sample / count;
        }
    } else {
        // moving, the history is clamped to the colours this frame's neighbourhood holds, so a
        // stale colour cannot survive where nothing like it is drawn any more
        if (moving && uniform.taaControl.y > 0.0) {
            var m1 = vec4f(0.0);
            var m2 = vec4f(0.0);
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    let n = sampleAt(pix + vec2i(dx, dy), dims);
                    m1 += n;
                    m2 += n * n;
                }
            }
            let mu = m1 / 9.0;
            let sd = sqrt(max(m2 / 9.0 - mu * mu, vec4f(0.0)));
            let halfWidth = sd * uniform.taaControl.y;
            hist = clamp(hist, mu - halfWidth, mu + halfWidth);
        }
        // the faster the image moves, the shorter the history: a stochastic pixel's layers
        // reproject through one layer's depth, so their parallax smears the history by an
        // amount that grows with the motion, and a raw frame is the better estimate past it
        var cap = maxCount;
        if (moving && uniform.taaFilter.z > 0.0) {
            let speed = length(r.uv * vec2f(dims) - vec2f(pix) - vec2f(0.5));
            cap = max(2.0, maxCount / (1.0 + speed / uniform.taaFilter.z));
        }
        count = min(info.count + 1.0, cap);
        let w = 1.0 / count;
        color = mix(hist, sample, w);
        // an empty sample takes at least a step off the coverage: rounded to the nearest, a
        // decay of less than half a step holds (below cap / 2 steps, about 0.002 at the default
        // cap), so a faint pixel would keep its coverage, and the depth the compose writes for
        // it, forever. The colour follows, since the encoding keeps it within the coverage
        if (sample.a == 0.0) {
            color.a = min(color.a, max(hist.a - 1.0 / TAA_COLOR_SCALE, 0.0));
        }
        // carry the mean depth into this view: the point moved along the ray by the change in
        // its depth, then the sample joins it
        let shifted = info.depth + (carryDepth - r.prevDepth);
        mean = select(shifted, shifted + w * (d - shifted), hit);
    }

    if (uniform.taaDebug > 1.5) {
        // the reprojection offset in pixels, 8 px full scale, centred on 0.5
        let mv = select(vec2f(0.0), r.uv * vec2f(dims) - vec2f(pix) - vec2f(0.5), r.valid);
        color = vec4f(mv / 16.0 + vec2f(0.5), select(0.0, 1.0, r.valid), 1.0);
    } else if (uniform.taaDebug > 0.5) {
        color = vec4f(count / maxCount, select(0.0, 1.0, accepted), select(0.0, 1.0, moving), 1.0);
    }
    output.color = encodeColor(color);
    output.color1 = encodeInfo(mean, count);
    return output;
}
`;

// The compose: a fullscreen quad in the World layer's transparent sublayer that blends the
// stochastic target over the camera's target (after the skybox and opaque meshes) and writes
// its depth, so everything drawn later depth-tests against the splats. The colour transform
// the engine's own splat shader applies (gsplatOutputVS: tonemap and gamma, or the viewer's
// pass-through patch under CameraFrame) runs here, once per pixel instead of once per splat.
const composeVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;
const composeFragmentWGSL = /* wgsl */ `
#include "gsplatOutputVS"

var splatColor: texture_2d<f32>;
var splatColorSampler: sampler;
var splatDepth: texture_depth_2d;
// the temporally accumulated frame (premultiplied colour, coverage), when taa ran this frame
var taaColor: texture_2d<u32>;
// its depth record: the mean view depth of the pixel's samples and their count
var taaInfo: texture_2d<u32>;
// x: 1 when the splat target's rows run the other way to the camera target's; y: 1 for an
// orthographic camera; z: 1 to read the taa history instead of the raw frame
uniform composeParams: vec4f;
// the splat target's depth: clip z = a * viewDepth + b over w = viewDepth (x, y), and the
// camera's near and far (z, w) for the depth view
uniform depthViewParams: vec4f;
// the camera's own depth, the one written for the rest of the scene: clip z = a * viewDepth + b
// (x, y). The splat target's far plane is at infinity where the camera's is fitted to the scene
uniform cameraClipZ: vec4f;

${taaHistoryWGSL}

const FAR_DEPTH = 0.999999;

// the splat target's depth texel of a view depth, just inside its far plane at most: the
// raster clamps there too, since a depth of 1 reads as no sample
fn clipZOf(viewDepth: f32) -> f32 {
    let p = uniform.depthViewParams;
    let w = select(viewDepth, 1.0, uniform.composeParams.y > 0.5);
    return min(clamp(p.x * viewDepth + p.y, 0.0, w) / w, FAR_DEPTH);
}

// the view depth of a splat target depth texel
fn viewDepthOf(z: f32) -> f32 {
    let p = uniform.depthViewParams;
    let dz = z - p.x;
    let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
    return select(p.y / safeDz, (z - p.y) / p.x, uniform.composeParams.y > 0.5);
}

// A splat target depth in the camera's depth, clamped just inside the camera's far plane as the
// engine clamps its splats: splats beyond it stay behind everything the scene draws
fn cameraDepthOf(z: f32) -> f32 {
    let viewDepth = viewDepthOf(z);
    let c = uniform.cameraClipZ;
    let w = select(viewDepth, 1.0, uniform.composeParams.y > 0.5);
    return min(clamp(c.x * viewDepth + c.y, 0.0, w) / w, FAR_DEPTH);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let dims = vec2i(textureDimensions(splatColor));
    var pix = vec2i(pcPosition.xy);
    if (uniform.composeParams.x > 0.5) {
        pix.y = dims.y - 1 - pix.y;
    }
    pix = clamp(pix, vec2i(0), dims - vec2i(1));

    var depth = textureLoad(splatDepth, pix, 0);
    var color: vec4f;
    if (uniform.composeParams.z > 0.5) {
        // the accumulated history: coverage in alpha, colour premultiplied by it
        color = decodeColor(textureLoad(taaColor, pix, 0));
        if (depth >= 1.0 && color.a > 0.001) {
            // covered by the history but no sample this frame, which a faint pixel sees on
            // most frames: the mean depth of the pixel's own samples, or, for a history this
            // frame started (moving, from the quad's samples), the nearest sampled neighbour's,
            // so the pixel still occludes what is behind the splats
            let info = decodeInfo(textureLoad(taaInfo, pix, 0).x);
            if (info.count > 0.5) {
                depth = clipZOf(info.depth);
            } else {
                for (var dy = -1; dy <= 1; dy++) {
                    for (var dx = -1; dx <= 1; dx++) {
                        depth = min(depth, textureLoad(splatDepth, clamp(pix + vec2i(dx, dy), vec2i(0), dims - vec2i(1)), 0));
                    }
                }
            }
        }
    } else {
        #ifdef SSE_SPP_QUAD
            // the mean of each 2x2 quad, bilinearly interpolated between quad centres: the four
            // strata of the raster's thresholds average out to the splat's coverage. Empty texels
            // are transparent black, so the result is premultiplied coverage
            let size = vec2f(dims);
            let u = (vec2f(pix) - vec2f(0.5)) * 0.5;
            let q0 = floor(u);
            let f = u - q0;
            let uv = (q0 * 2.0 + vec2f(1.0)) / size;
            let step = vec2f(2.0) / size;
            let a = textureSampleLevel(splatColor, splatColorSampler, uv, 0.0);
            let b = textureSampleLevel(splatColor, splatColorSampler, uv + vec2f(step.x, 0.0), 0.0);
            let c = textureSampleLevel(splatColor, splatColorSampler, uv + vec2f(0.0, step.y), 0.0);
            let d = textureSampleLevel(splatColor, splatColorSampler, uv + step, 0.0);
            color = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            if (depth >= 1.0) {
                // no sample at this pixel but coverage from its quad: the quad's nearest depth
                let quad = (pix >> vec2u(1u)) << vec2u(1u);
                depth = min(
                    min(textureLoad(splatDepth, quad, 0), textureLoad(splatDepth, min(quad + vec2i(1, 0), dims - 1), 0)),
                    min(textureLoad(splatDepth, min(quad + vec2i(0, 1), dims - 1), 0), textureLoad(splatDepth, min(quad + vec2i(1, 1), dims - 1), 0))
                );
            }
        #else
            color = textureLoad(splatColor, pix, 0);
        #endif
    }
    if (color.a <= 0.001) {
        discard;
    }
    // coverage with no depth anywhere near: shown, behind everything the scene drew
    depth = min(depth, FAR_DEPTH);

    #ifdef SSE_SHOW_DEPTH
        // the nearest sample's view depth, log-spaced between near and far, as grey
        let p = uniform.depthViewParams;
        let viewDepth = viewDepthOf(depth);
        let t = clamp(log(max(viewDepth, p.z) / p.z) / log(p.w / p.z), 0.0, 1.0);
        // 24-bit fixed point across rgb (high byte in red), so a capture can read it precisely
        let fixed = floor(t * 16777215.0);
        let hi = floor(fixed / 65536.0);
        let mid = floor((fixed - hi * 65536.0) / 256.0);
        let lo = fixed - hi * 65536.0 - mid * 256.0;
        output.color = vec4f(vec3f(hi, mid, lo) / 255.0, 1.0);
        output.fragDepth = cameraDepthOf(depth);
        return output;
    #endif

    // un-premultiply for the output transform, then premultiply for the blend
    let gamma = color.rgb / color.a;
    let rgb = prepareOutputFromGamma(gamma, 0.0);
    output.color = vec4f(rgb * color.a, color.a);
    output.fragDepth = cameraDepthOf(depth);
    return output;
}
`;

// The projector: one 256-thread workgroup per chunk of the resident set. Each thread reads one
// splat through the source's read code, projects it, applies the culls, and survivors append
// themselves to a dense cache with one global atomic per workgroup. The chunk table and node
// visibility come from the cpu (resident-set rebuild on version change, frustum cull per frame).
/** Words per cache entry. See the layout in the plan: ndc, depth, axis1, len2|alpha|flags, rgb, popless, id. */
const CACHE_WORDS = 7;
const PROJECTOR_WORKGROUP_SIZE = 256;
/** Buckets of the counting order (order:bucket); the workgroup size, so each thread owns one. */
const ORDER_BUCKETS = PROJECTOR_WORKGROUP_SIZE;
/** Splats per chunk-table entry; a chunk is one workgroup. */
const CHUNK_SIZE = PROJECTOR_WORKGROUP_SIZE;
const projectorWGSL = (readChunk, occlusion, order) => /* wgsl */ `
struct ProjectorUniforms {
    view: mat4x4f,
    viewProj: mat4x4f,
    // the previous frame, for the occlusion cull: its view and view-projection, its clip-z
    // mapping (a, b, isOrtho, 0), viewport and focal length
    prevViewProj: mat4x4f,
    prevView: mat4x4f,
    prevClipZ: vec4f,
    viewport: vec2f,
    focal: vec2f,
    prevViewport: vec2f,
    prevFocal: vec2f,
    numChunks: u32,
    splatTextureSize: u32,
    isOrtho: u32,
    minPixelSize: f32,
    alphaClip: f32,
    minContribution: f32,
    // the occlusion grid: level 1 (8 px) and level 2 (32 px) block counts
    occBlocksX1: u32,
    occBlocksY1: u32,
    occBlocksX2: u32,
    occBlocksY2: u32,
    // 0 off, 1 level 1 only, 2 both levels
    occlusionMode: u32,
    // -1 when the previous depth texture's rows run bottom-up (an offscreen target), else 1
    prevFlip: f32,
    // the order key: bucket = (log(depth) - keyLogNear) * keyInvLogRange, over [0, 1)
    keyLogNear: f32,
    keyInvLogRange: f32,
    // first chunk-table entry of this dispatch (per-file sources dispatch one run each)
    chunkBase: u32,
    // the file's model transform, for sources that read splats in the file's own space
    model: mat4x4f,
    modelRotation: vec4f,
    modelScale: vec4f,
    cameraPosition: vec4f,
    // colour ceiling per channel: 8 keeps the cache's range, 1 clamps like the engine's 8-bit cache
    colorMax: f32,
    // 1: covariance in true pixels. 2: the engine's convention (its focal is viewport * proj[0][0],
    // twice the pixel focal), which makes its 0.3 dilation 0.075 px^2 and scales its culls
    unitScale: f32,
    // the view depths of the near plane and of the raster's far clamp
    depthNear: f32,
    depthFar: f32
}

// chunk table entry: slotBase, count, node, lod | file << 16
@group(0) @binding(0) var<storage, read> chunks: array<vec4u>;
// one bit per node: 1 = inside the frustum this frame
@group(0) @binding(1) var<storage, read> nodeVisible: array<u32>;
@group(0) @binding(2) var<storage, read_write> cache: array<u32>;
// [0] survivors this frame, [1] splats the occlusion cull removed
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> uniforms: ProjectorUniforms;
// the previous frame's farthest depth per block, as f32 bits (see shaders/reduce.ts)
@group(0) @binding(5) var<storage, read> occL1: array<u32>;
@group(0) @binding(6) var<storage, read> occL2: array<u32>;
// order:bucket: survivors per depth bucket (see shaders/order.ts)
@group(0) @binding(7) var<storage, read_write> buckets: array<atomic<u32>>;

struct Splat {
    index: u32,
    uv: vec2i
}
var<private> splat: Splat;
fn setSplat(idx: u32) {
    splat.index = idx;
    splat.uv = vec2i(i32(idx % uniforms.splatTextureSize), i32(idx / uniforms.splatTextureSize));
}

${readChunk}

// quaternion (x, y, z, w) to a rotation matrix (columns)
fn rotationMatrix(qIn: vec4f) -> mat3x3f {
    let q = normalize(qIn);
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
    return mat3x3f(
        vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
        vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
        vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
    );
}

struct Projected {
    valid: bool,
    occluded: bool,
    words: array<u32, ${CACHE_WORDS}>
}

// The farthest depth over the (2g+1)^2 blocks around a block, on one grid level.
fn farthestL1(block: vec2i, gather: i32, blocks: vec2i) -> u32 {
    var farthest = 0u;
    for (var dy = -gather; dy <= gather; dy++) {
        for (var dx = -gather; dx <= gather; dx++) {
            farthest = max(farthest, occL1[u32((block.y + dy) * blocks.x + block.x + dx)]);
        }
    }
    return farthest;
}

fn farthestL2(block: vec2i, gather: i32, blocks: vec2i) -> u32 {
    var farthest = 0u;
    for (var dy = -gather; dy <= gather; dy++) {
        for (var dx = -gather; dx <= gather; dx++) {
            farthest = max(farthest, occL2[u32((block.y + dy) * blocks.x + block.x + dx)]);
        }
    }
    return farthest;
}

fn project(slot: u32, file: u32) -> Projected {
    var result: Projected;
    result.valid = false;
    result.occluded = false;

    setSplat(slot);
    let center = srcCenter();
    let opacity = srcOpacity();
    if (opacity < uniforms.alphaClip) {
        return result;
    }

    let viewCenter = uniforms.view * vec4f(center, 1.0);
    let depth = -viewCenter.z;
    if (uniforms.isOrtho == 0u && depth <= 0.0) {
        return result;
    }
    let clip = uniforms.viewProj * vec4f(center, 1.0);
    if (clip.w == 0.0) {
        return result;
    }

    let viewport = uniforms.viewport;
    let focal = uniforms.focal;

    // the work buffer holds world-space splats, so the view matrix is the model-view
    let rot = srcRotation();
    let scale = srcScale();
    let linear = mat3x3f(uniforms.view[0].xyz, uniforms.view[1].xyz, uniforms.view[2].xyz);
    let gaussian = linear * rotationMatrix(vec4f(rot.yzw, rot.x)) * mat3x3f(
        vec3f(scale.x, 0.0, 0.0),
        vec3f(0.0, scale.y, 0.0),
        vec3f(0.0, 0.0, scale.z)
    );
    let row0 = vec3f(gaussian[0].x, gaussian[1].x, gaussian[2].x);
    let row1 = vec3f(gaussian[0].y, gaussian[1].y, gaussian[2].y);
    let row2 = vec3f(gaussian[0].z, gaussian[1].z, gaussian[2].z);
    let c00 = dot(row0, row0);
    let c01 = dot(row0, row1);
    let c02 = dot(row0, row2);
    let c11 = dot(row1, row1);
    let c12 = dot(row1, row2);
    let c22 = dot(row2, row2);

    var cov00: f32;
    var cov01: f32;
    var cov11: f32;
    if (uniforms.isOrtho != 0u) {
        cov00 = focal.x * focal.x * c00;
        cov01 = focal.x * focal.y * c01;
        cov11 = focal.y * focal.y * c11;
    } else {
        let safeDepth = max(depth, 0.001);
        let invDepth = 1.0 / safeDepth;
        let jx0 = focal.x * invDepth;
        let jx2 = focal.x * viewCenter.x * invDepth * invDepth;
        let jy1 = focal.y * invDepth;
        let jy2 = focal.y * viewCenter.y * invDepth * invDepth;
        let u00 = jx0 * c00 + jx2 * c02;
        let u01 = jx0 * c01 + jx2 * c12;
        let u02 = jx0 * c02 + jx2 * c22;
        let u11 = jy1 * c11 + jy2 * c12;
        let u12 = jy1 * c12 + jy2 * c22;
        cov00 = u00 * jx0 + u02 * jx2;
        cov01 = u01 * jy1 + u02 * jy2;
        cov11 = u11 * jy1 + u12 * jy2;
    }

    // the low-pass dilation every splat renderer applies, 0.3 in the chosen units
    let us2 = uniforms.unitScale * uniforms.unitScale;
    cov00 += 0.3 / us2;
    cov11 += 0.3 / us2;
    let determinant = cov00 * cov11 - cov01 * cov01;
    if (determinant <= 0.0) {
        return result;
    }

    let mid = 0.5 * (cov00 + cov11);
    let radius = length(vec2f(0.5 * (cov00 - cov11), cov01));
    let lambda1 = mid + radius;
    let lambda2 = max(mid - radius, 0.1 / us2);

    // size cull on the footprint's radius in pixels. minPixelSize is a diameter: the engine's
    // projector is dispatched with half of it, and its quad path tests the full extent
    // (2 sqrt(2 lambda)) against the whole value, so both cut at the same place
    if (uniforms.unitScale * sqrt(2.0 * lambda1) < 0.5 * uniforms.minPixelSize) {
        return result;
    }

    // contribution cull: the splat's alpha mass in pixels (the engine's minContribution rule)
    if (opacity * 6.283185 * sqrt(determinant) * us2 < uniforms.minContribution) {
        return result;
    }

    // principal axis; a circular footprint has no defined eigenvector, any axis is right
    let eigenVec = vec2f(cov01, lambda1 - cov00);
    let eigenLen = length(eigenVec);
    let direction = select(vec2f(1.0, 0.0), eigenVec / eigenLen, eigenLen > 1e-9);
    let maxRadius = min(1024.0, min(viewport.x, viewport.y));
    let len1 = 2.0 * sqrt(2.0 * lambda1);
    let radiusScale = min(1.0, maxRadius / len1);
    let axis1 = len1 * radiusScale * direction;
    let len2 = 2.0 * sqrt(2.0 * lambda2) * radiusScale;
    let axis2 = len2 * vec2f(direction.y, -direction.x);

    let ndc = clip.xy / clip.w;
    let extent = abs(axis1) + abs(axis2);
    let centerPixels = (ndc * 0.5 + 0.5) * viewport;
    if (centerPixels.x + extent.x < 0.0 || centerPixels.x - extent.x > viewport.x
        || centerPixels.y + extent.y < 0.0 || centerPixels.y - extent.y > viewport.y) {
        return result;
    }

${occlusion
    ? `
    // Occlusion cull against the previous frame. Each stored depth is the nearest sample that
    // survived there, so the farthest depth over the blocks a splat covered bounds what could
    // still have shown behind it; a splat whose front (its centre less 2 sqrt(2) sigma along the
    // view, the same cut-off as the quad's edge) lies beyond that bound was invisible last
    // frame, up to sampling. Static splats reproject exactly through the previous view, so only
    // true disocclusions arrive a frame late. The footprint the splat had last frame bounds the
    // gather; footprints up to 16 px use the 8 px grid, up to 64 px the 32 px grid, larger ones
    // skip the test.
    if (uniforms.occlusionMode != 0u) {
        let prevClip = uniforms.prevViewProj * vec4f(center, 1.0);
        let prevDepth = -(uniforms.prevView * vec4f(center, 1.0)).z;
        let prevOrtho = uniforms.prevClipZ.z != 0.0;
        if (prevClip.w > 0.0 && (prevOrtho || prevDepth > 0.0)) {
            let prevNdc = prevClip.xy / prevClip.w;
            let halfExtent = len1 * radiusScale;
            let prevHalfExtent = halfExtent * (uniforms.prevFocal.x / focal.x)
                * select(depth / max(prevDepth, 0.001), 1.0, prevOrtho);
            let footprint = max(halfExtent, prevHalfExtent);
            var level = 1u;
            var blockSize = 8.0;
            var blocks = vec2i(i32(uniforms.occBlocksX1), i32(uniforms.occBlocksY1));
            if (footprint > 16.0) {
                level = 2u;
                blockSize = 32.0;
                blocks = vec2i(i32(uniforms.occBlocksX2), i32(uniforms.occBlocksY2));
            }
            if (footprint <= 64.0 && level <= uniforms.occlusionMode) {
                let gather = max(i32(ceil(footprint / blockSize)), 1);
                let prevPixel = vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * uniforms.prevFlip * 0.5) * uniforms.prevViewport;
                let block = vec2i(floor(prevPixel / blockSize));
                if (block.x >= gather && block.y >= gather && block.x < blocks.x - gather && block.y < blocks.y - gather) {
                    let front = prevDepth - 2.8284 * sqrt(c22);
                    let w = select(front, 1.0, prevOrtho);
                    if (w > 0.0) {
                        let frontZ = clamp(uniforms.prevClipZ.x * front + uniforms.prevClipZ.y, 0.0, w) / w;
                        // the block under the centre first: the neighbourhood's maximum is at
                        // least its maximum, so a splat that block alone cannot cull is visible,
                        // and most splats leave here after one load
                        let centreIndex = u32(block.y * blocks.x + block.x);
                        var farthest = select(occL1[centreIndex], occL2[centreIndex], level == 2u);
                        if (frontZ > bitcast<f32>(farthest)) {
                            if (level == 1u) {
                                farthest = farthestL1(block, gather, blocks);
                            } else {
                                farthest = farthestL2(block, gather, blocks);
                            }
                            if (frontZ > bitcast<f32>(farthest)) {
                                result.occluded = true;
                                return result;
                            }
                        }
                    }
                }
            }
        }
    }

`
    : ''}
    let color = clamp(srcColor(), vec3f(0.0), vec3f(uniforms.colorMax));

    // rgb: 10/10/10 unorm with a 2-bit shared exponent (scale 1/2/4/8, range [0, 8])
    let maxChannel = max(color.r, max(color.g, color.b));
    var exponent = 0u;
    if (maxChannel > 4.0) {
        exponent = 3u;
    } else if (maxChannel > 2.0) {
        exponent = 2u;
    } else if (maxChannel > 1.0) {
        exponent = 1u;
    }
    let rgb = vec3u(clamp(color / f32(1u << exponent), vec3f(0.0), vec3f(1.0)) * 1023.0 + 0.5);

    // centre as snorm16 over the range the offscreen cull bounds visible centres to; the
    // raster shader derives the same range from its viewport
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / viewport;

    result.valid = true;
    result.words[0] = pack2x16snorm(ndc / ndcRange);
    result.words[1] = bitcast<u32>(depth);
    result.words[2] = pack2x16float(axis1);
    result.words[3] = pack2x16float(vec2f(len2, 0.0)) | (u32(clamp(opacity, 0.0, 1.0) * 255.0 + 0.5) << 16u);
${order
    ? `
    // the depth bucket, log-spaced from the near plane, in the flags byte
    let key = clamp((log(max(depth, 1e-6)) - uniforms.keyLogNear) * uniforms.keyInvLogRange, 0.0, 0.999) * ${ORDER_BUCKETS}.0;
    result.words[3] |= u32(key) << 24u;
`
    : ''}
    result.words[4] = rgb.r | (rgb.g << 10u) | (rgb.b << 20u) | (exponent << 30u);
    // Popless depth (StochasticSplats 3.4): the quad is tilted onto the plane through the
    // centre with normal adj(Sigma) mu (view space; adj rather than the inverse, so a flat
    // splat needs no division by its tiny determinant), and the raster gives each corner the
    // depth where its own view ray meets that plane, so hardware interpolation hands every
    // fragment the depth of the Gaussian's peak along its ray instead of the centre's. Stored
    // as g = n.xy / (n . mu): a corner at view offset d (in the plane z = -depth) lands at
    // depth / (1 + g . d). Orthographic rays are parallel, so there n = adj(Sigma) e_z and
    // the corner depth is depth + g . d with g = n.xy / n.z. Bounded so every corner stays
    // within 2 sqrt(2) sigma_z of the centre (the occlusion cull's front margin) and the
    // perspective scale stays positive, and so no corner crosses the near plane or the
    // raster's far clamp: a corner clamped there while the others are not bends the quad, whose
    // two triangles then take different depths and show as polygons (large far splats, the
    // sky, sit right at a far plane fitted to the scene). A centre beyond the clamp stays flat.
    let ortho = uniforms.isOrtho != 0u;
    let a00 = c11 * c22 - c12 * c12;
    let a01 = c02 * c12 - c01 * c22;
    let a02 = c01 * c12 - c02 * c11;
    let a11 = c00 * c22 - c02 * c02;
    let a12 = c01 * c02 - c00 * c12;
    let a22 = c00 * c11 - c01 * c01;
    let toward = select(viewCenter.xyz, vec3f(0.0, 0.0, -1.0), ortho);
    let n = vec3f(
        a00 * toward.x + a01 * toward.y + a02 * toward.z,
        a01 * toward.x + a11 * toward.y + a12 * toward.z,
        a02 * toward.x + a12 * toward.y + a22 * toward.z
    );
    let denom = select(dot(n, viewCenter.xyz), n.z, ortho);
    var g = vec2f(0.0);
    if (abs(denom) > 1e-20) {
        g = n.xy / denom;
        // view units per pixel at the centre's depth, and the quad's half extents in them
        let viewScale = select(depth, 1.0, ortho) / focal;
        let ext = (abs(axis1) + abs(axis2)) * viewScale;
        let bound = abs(g.x) * ext.x + abs(g.y) * ext.y;
        let margin = 2.8284 * sqrt(max(c22, 0.0));
        let inRange = select(
            min(1.0 - depth / uniforms.depthFar, depth / max(uniforms.depthNear, 1e-6) - 1.0),
            min(uniforms.depthFar - depth, depth - uniforms.depthNear),
            ortho
        );
        let limit = max(0.0, min(select(min(0.25, margin / max(depth, 1e-6)), margin, ortho), 0.999 * inRange));
        if (bound > limit) {
            g *= limit / max(bound, 1e-20);
        }
    }
    result.words[5] = pack2x16float(g);
    // the stable id the coverage hash seeds from: the slot, salted by the file for sources
    // whose indices restart per file
    result.words[6] = slot ^ (file * 2654435761u);
    return result;
}

var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgOccluded: atomic<u32>;
var<workgroup> wgBase: u32;
${order ? `var<workgroup> wgBuckets: array<atomic<u32>, ${ORDER_BUCKETS}>;` : ''}

@compute @workgroup_size(${PROJECTOR_WORKGROUP_SIZE})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    // no early returns: the barriers below need every thread of the workgroup
    let chunkIndex = wg.x + wg.y * numWorkgroups.x;
${order ? `    atomicStore(&wgBuckets[local], 0u);` : ''}
    var projected: Projected;
    projected.valid = false;
    projected.occluded = false;
    if (chunkIndex < uniforms.numChunks) {
        let chunk = chunks[uniforms.chunkBase + chunkIndex];
        let visible = (nodeVisible[chunk.z >> 5u] >> (chunk.z & 31u)) & 1u;
        if (visible != 0u && local < chunk.y) {
            projected = project(chunk.x + local, chunk.w >> 16u);
        }
    }

    // survivors claim consecutive slots: one workgroup-local count, one global atomic
    var localSlot = 0u;
    if (projected.valid) {
        localSlot = atomicAdd(&wgCount, 1u);
    }
    if (projected.occluded) {
        atomicAdd(&wgOccluded, 1u);
    }
    workgroupBarrier();
    if (local == 0u) {
        let n = atomicLoad(&wgCount);
        wgBase = select(0u, atomicAdd(&counter[0], n), n > 0u);
        let o = atomicLoad(&wgOccluded);
        if (o > 0u) {
            atomicAdd(&counter[1], o);
        }
    }
    workgroupBarrier();
    if (projected.valid) {
        let base = (wgBase + localSlot) * ${CACHE_WORDS}u;
        for (var i = 0u; i < ${CACHE_WORDS}u; i++) {
            cache[base + i] = projected.words[i];
        }
${order ? `        atomicAdd(&wgBuckets[projected.words[3] >> 24u], 1u);` : ''}
    }
${order
    ? `
    // a chunk's splats are spatially coherent, so few of its buckets are non-empty: one
    // workgroup count each, then one global atomic per non-empty bucket
    workgroupBarrier();
    let bucketCount = atomicLoad(&wgBuckets[local]);
    if (bucketCount > 0u) {
        atomicAdd(&buckets[local], bucketCount);
    }
`
    : ''}
}
`;

// The ordering passes (variant order:bucket): the projector counts its survivors into 256
// depth buckets, front to back; a one-workgroup scan turns the counts into bucket offsets, and
// the scatter writes each survivor's cache slot into the ordered list the raster then follows.
// Splats inside a bucket land in append order, so a bucket keeps its chunks' locality.
// exclusive prefix sum of the bucket counts into the bucket offsets, in one workgroup
const orderScanWGSL = /* wgsl */ `
// [0, ${ORDER_BUCKETS}) counts, [${ORDER_BUCKETS}, ${2 * ORDER_BUCKETS}) offsets
@group(0) @binding(0) var<storage, read_write> buckets: array<u32>;

var<workgroup> partial: array<u32, ${ORDER_BUCKETS}>;

@compute @workgroup_size(${ORDER_BUCKETS})
fn main(@builtin(local_invocation_index) local: u32) {
    partial[local] = buckets[local];
    for (var stride = 1u; stride < ${ORDER_BUCKETS}u; stride <<= 1u) {
        workgroupBarrier();
        let value = select(0u, partial[local - stride], local >= stride);
        workgroupBarrier();
        partial[local] += value;
    }
    // inclusive to exclusive
    buckets[${ORDER_BUCKETS}u + local] = partial[local] - buckets[local];
}
`;
// One thread per cache slot, one workgroup per 256 consecutive slots. Consecutive slots come
// from one chunk, so a workgroup touches few buckets: it counts them locally, claims each
// bucket's range with one global atomic, and places its splats in append order inside it.
const orderScatterWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<storage, read_write> buckets: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> ordered: array<u32>;

var<workgroup> wgCounts: array<atomic<u32>, ${ORDER_BUCKETS}>;
var<workgroup> wgBase: array<u32, ${ORDER_BUCKETS}>;

@compute @workgroup_size(${ORDER_BUCKETS})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    // no early returns: the barriers need every thread
    atomicStore(&wgCounts[local], 0u);
    let slot = (wg.x + wg.y * numWorkgroups.x) * ${ORDER_BUCKETS}u + local;
    let live = slot < counter[0];
    var key = 0u;
    var rank = 0u;
    workgroupBarrier();
    if (live) {
        key = cache[slot * ${CACHE_WORDS}u + 3u] >> 24u;
        rank = atomicAdd(&wgCounts[key], 1u);
    }
    workgroupBarrier();
    let count = atomicLoad(&wgCounts[local]);
    if (count > 0u) {
        wgBase[local] = atomicAdd(&buckets[${ORDER_BUCKETS}u + local], count);
    }
    workgroupBarrier();
    if (live) {
        ordered[wgBase[key] + rank] = slot;
    }
}
`;

// The raster pass: an indirect instanced draw of 128-quad meshes over the projector's
// survivors, into the renderer's own colour + depth target. Fragments keep themselves with
// probability alpha (StochasticSplats, Listing 1) and write opaque colour with hardware depth,
// so no sort is needed and the depth buffer holds the nearest surviving sample per pixel.
/** Quads per draw instance; the mesh holds this many quads. */
const QUADS_PER_INSTANCE = 128;
/** The raster's far clamp in normalised depth: just inside 1, which the compose reads as empty. */
const FAR_CLIP_Z = 0.999999;
const rasterVertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;

// width, height, 2 / width, 2 / height
uniform viewportSize: vec4f;
// clip z = a * viewDepth + b (x, y); z = 1 for an orthographic camera
uniform clipZParams: vec4f;
// set by the engine's forward renderer for the target being rendered
uniform projectionFlipY: f32;
// focal length in pixels (x, y), for the popless corner depths
uniform focalParams: vec4f;

var<storage, read> splatCache: array<u32>;
var<storage, read> splatCount: array<u32>;
#ifdef SSE_ORDERED
    // cache slots in draw order (variant order:bucket)
    var<storage, read> orderedSlots: array<u32>;
#endif

// screen-linear: the corners share one screen footprint whatever depth they carry
varying @interpolate(linear) gaussianUV: vec2f;
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
varying @interpolate(flat, either) splatId: u32;

const discardPosition = vec4f(0.0, 0.0, 2.0, 1.0);

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let order = pcInstanceIndex * ${QUADS_PER_INSTANCE}u + u32(vertex_position.z);
    // the indirect instance count rounds up to whole instances; the tail is discarded here
    if (order >= splatCount[0]) {
        output.position = discardPosition;
        return output;
    }

    #ifdef SSE_ORDERED
        let base = orderedSlots[order] * ${CACHE_WORDS}u;
    #else
        let base = order * ${CACHE_WORDS}u;
    #endif
    let maxRadius = min(1024.0, min(uniform.viewportSize.x, uniform.viewportSize.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / uniform.viewportSize.xy;
    let ndc = unpack2x16snorm(splatCache[base]) * ndcRange;
    let depth = bitcast<f32>(splatCache[base + 1u]);
    let ortho = uniform.clipZParams.z != 0.0;

    let axis1 = unpack2x16float(splatCache[base + 2u]);
    let word3 = splatCache[base + 3u];
    let len2 = unpack2x16float(word3).x;
    let axis2 = len2 * normalize(vec2f(axis1.y, -axis1.x));

    let corner = vertex_position.xy;
    let pixelOffset = corner.x * axis1 + corner.y * axis2;
    #ifdef SSE_POPLESS
        // the corner's depth on the splat's plane (see the projector): its view-space offset
        // at the centre's depth, times the stored gradient
        let g = unpack2x16float(splatCache[base + 5u]);
        let shift = dot(g, pixelOffset * select(depth, 1.0, ortho) / uniform.focalParams.xy);
        let cornerDepth = select(depth / (1.0 + shift), depth + shift, ortho);
    #else
        let cornerDepth = depth;
    #endif
    let w = select(cornerDepth, 1.0, ortho);
    let ndcCorner = ndc + pixelOffset * uniform.viewportSize.zw;
    // clip z clamped into range like the engine's splat shader, so splats beyond the far plane
    // still draw; just inside it, since the compose and the accumulation read depth 1 as empty
    let pos = vec4f(ndcCorner * w, clamp(uniform.clipZParams.x * cornerDepth + uniform.clipZParams.y, 0.0, w * ${FAR_CLIP_Z}), w);
    output.position = vec4f(pos.x, pos.y * uniform.projectionFlipY, pos.z, pos.w);
    output.gaussianUV = corner;
    output.packedColor = splatCache[base + 4u];
    output.packedAlpha = word3 >> 16u;
    output.splatId = splatCache[base + 6u];
    return output;
}
`;
const rasterFragmentWGSL = /* wgsl */ `
varying @interpolate(linear) gaussianUV: vec2f;
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
varying @interpolate(flat, either) splatId: u32;

uniform sseAlphaClip: f32;
// 0 while the camera rests, so a still frame reproduces itself; the frame index once TAA
// accumulates
uniform frameSeed: u32;

const EXP4 = exp(-4.0);
const INV_EXP4 = 1.0 / (1.0 - EXP4);

// the engine's falloff: zero at the quad edge, which sits at 2 sqrt(2) sigma
fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

// integer hash (Wellons' prospector mix)
fn hashU32(x: u32) -> u32 {
    var v = x;
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let radius = dot(gaussianUV, gaussianUV);
    if (radius > 1.0) {
        discard;
    }
    let opacity = f32(packedAlpha & 0xffu) / 255.0;
    let alpha = normExp(radius) * opacity;
    if (alpha < uniform.sseAlphaClip) {
        discard;
    }

    let pix = vec2u(pcPosition.xy);
    #ifdef SSE_SPP_QUAD
        // one sample per pixel, thresholds stratified over each 2x2 pixel quad: the quad's four
        // pixels take the four strata of [0, 1) in a per-(quad, splat) scrambled order, so a
        // splat with alpha a covers 4a +- 1 of its quad and the compose's quad mean is nearly
        // exact. Hashing quad and splat keeps overlapping splats decorrelated
        let quad = pix >> vec2u(1u);
        let h = hashU32((quad.x * 1973u) ^ (quad.y * 9277u) ^ ((splatId + 1u) * 26699u) ^ uniform.frameSeed);
        let stratum = ((pix.y & 1u) * 2u + (pix.x & 1u)) ^ (h & 3u);
        let rnd = (f32(stratum) + f32(h >> 8u) * (1.0 / 16777216.0)) * 0.25;
    #else
        let h = hashU32((pix.x * 1973u) ^ (pix.y * 9277u) ^ ((splatId + 1u) * 26699u) ^ uniform.frameSeed);
        let rnd = f32(h >> 8u) * (1.0 / 16777216.0);
    #endif
    if (rnd >= alpha) {
        discard;
    }

    let bits = packedColor;
    let color = vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0);
    // opaque coverage: the compose reads alpha 1 as "a sample landed here"
    output.color = vec4f(color, 1.0);
    return output;
}
`;

// The occlusion grid: the previous frame's depth texture reduced to the farthest depth per 8x8
// pixel block (level 1), and the farthest of each 4x4 group of those (level 2, 32 px). Each
// pixel's depth is the nearest surviving sample there, so a block's maximum bounds what could
// still have shown behind it; a splat whose front lies beyond that bound over every block it
// covers was invisible last frame. Depths are hardware z in [0, 1], stored as their f32 bits
// (non-negative floats order the same as their bits, so atomicMax works on them).
const reduceL1WGSL = /* wgsl */ `
struct ReduceUniforms {
    width: u32,
    height: u32,
    blocksX: u32,
    blocksY: u32
}

@group(0) @binding(0) var prevDepth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> blockMax: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ReduceUniforms;

var<workgroup> wgMax: atomic<u32>;

@compute @workgroup_size(8, 8)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(local_invocation_id) lid: vec3u,
    @builtin(local_invocation_index) li: u32
) {
    let pixel = wg.xy * 8u + lid.xy;
    // pixels off the texture count as far, so an edge block never culls
    var depth = 1.0;
    if (pixel.x < uniforms.width && pixel.y < uniforms.height) {
        depth = textureLoad(prevDepth, vec2i(pixel), 0);
    }
    atomicMax(&wgMax, bitcast<u32>(depth));
    workgroupBarrier();
    if (li == 0u) {
        blockMax[wg.y * uniforms.blocksX + wg.x] = atomicLoad(&wgMax);
    }
}
`;
const reduceL2WGSL = /* wgsl */ `
struct ReduceUniforms {
    blocksX1: u32,
    blocksY1: u32,
    blocksX2: u32,
    blocksY2: u32
}

@group(0) @binding(0) var<storage, read> level1: array<u32>;
@group(0) @binding(1) var<storage, read_write> level2: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ReduceUniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= uniforms.blocksX2 * uniforms.blocksY2) {
        return;
    }
    let bx = index % uniforms.blocksX2;
    let by = index / uniforms.blocksX2;
    var farthest = 0u;
    for (var dy = 0u; dy < 4u; dy++) {
        for (var dx = 0u; dx < 4u; dx++) {
            let x = bx * 4u + dx;
            let y = by * 4u + dy;
            if (x < uniforms.blocksX1 && y < uniforms.blocksY1) {
                farthest = max(farthest, level1[y * uniforms.blocksX1 + x]);
            } else {
                farthest = max(farthest, bitcast<u32>(1.0));
            }
        }
    }
    level2[index] = farthest;
}
`;

// Data path (ii): the projector reads each resident file's own textures (sog, ply or
// compressed ply) through the engine's format read chunks, so nothing is copied into a work
// buffer: no decoded 24-byte copy per splat, no re-copy when a node's lod changes, no
// colour refresh when the camera turns. The price is one dispatch per resident file, the
// model transform and the sh evaluation per splat per frame.
//
// Interim: the engine still allocates its work buffer and would keep copying into it, so the
// copy passes are switched off on the work buffer this source sees; the textures themselves
// stay until engine change E2 (no work buffer in external mode) lands.
const tmpScale = new Vec3();
const tmpRotation = new Quat();
class DirectSplatSource {
    kind = 'direct';
    device;
    resource = null;
    set = null;
    constants = new Map();
    patched = null;
    constructor(device) {
        this.device = device;
    }
    update(set, manager) {
        // one format per scene: a sog lod set shares its format across files. The first file's
        // format compiles the projector; a file of another format is skipped by dispatchPlan
        this.resource = set.files[0]?.resource ?? this.resource;
        this.set = set;
        this.constants.clear();
        for (const file of set.files) {
            const m = file.modelMatrix;
            m.getScale(tmpScale);
            tmpRotation.setFromMat4(m);
            if (tmpRotation.w < 0)
                tmpRotation.mulScalar(-1);
            this.constants.set(file.fileIndex, {
                rotation: [tmpRotation.x, tmpRotation.y, tmpRotation.z, tmpRotation.w],
                scale: [tmpScale.x, tmpScale.y, tmpScale.z, 0]
            });
        }
        this.patchWorkBuffer(manager.world.workBuffer);
    }
    // the engine's copy into the work buffer is wasted work for this path
    patchWorkBuffer(workBuffer) {
        if (this.patched?.workBuffer === workBuffer)
            return;
        this.restoreWorkBuffer();
        this.patched = { workBuffer, render: workBuffer.render, renderColor: workBuffer.renderColor };
        const skip = () => undefined;
        workBuffer.render = skip;
        workBuffer.renderColor = skip;
    }
    restoreWorkBuffer() {
        if (!this.patched)
            return;
        const { workBuffer, render, renderColor } = this.patched;
        workBuffer.render = render;
        workBuffer.renderColor = renderColor;
        this.patched = null;
    }
    readChunk(bindingBase) {
        const format = this.require().format;
        // The format's read chunk reads the file's own space and returns sh0 colour + alpha;
        // the adapter below applies the file's model transform and evaluates its sh for this
        // camera. Its loose `uniform` and texture declarations (dequantisation constants, the
        // compressed format's chunk texture) are reflected by the engine into a second bind
        // group and set by name like any other parameter.
        // The engine writes its 32-bit float streams (the sog v2 codebook) as `texture_2d<uff>`,
        // an alias only its reflection of loose declarations resolves; explicit bindings need
        // the wgsl type, and the matching unfilterable sample type in bindFormats()
        const declarations = format
            .getComputeInputDeclarations(bindingBase)
            .replace(/texture_2d<uff>/g, 'texture_2d<f32>');
        return /* wgsl */ `
#include "halfTypesCS"
#include "gsplatEvalSHVS"
${declarations}
${format.getReadCode()}

var<private> srcWorldCenter: vec3f;
var<private> srcColorCache: vec4f;

fn quatMulF(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// v rotated by the inverse of q (x, y, z, w)
fn quatRotateInvF(q: vec4f, v: vec3f) -> vec3f {
    let u = -q.xyz;
    return v + 2.0 * cross(u, cross(u, v) + q.w * v);
}

fn srcCenter() -> vec3f {
    srcWorldCenter = (uniforms.model * vec4f(getCenter(), 1.0)).xyz;
    return srcWorldCenter;
}

fn srcOpacity() -> f32 {
    srcColorCache = getColor();
    return srcColorCache.a;
}

// the format returns (w, x, y, z); world = model * source
fn srcRotation() -> vec4f {
    let q = quatMulF(uniforms.modelRotation, getRotation().yzwx);
    return q.wxyz;
}

fn srcScale() -> vec3f {
    return uniforms.modelScale.xyz * getScale();
}

fn srcColor() -> vec3f {
    var color = srcColorCache.rgb;
    #if SH_BANDS > 0
        // the view direction in the file's space; orthographic rays all run along the camera forward
        let view = uniforms.view;
        let orthoDir = vec3f(0.0, 0.0, -1.0) * mat3x3f(view[0].xyz, view[1].xyz, view[2].xyz);
        let viewDir = select(srcWorldCenter - uniforms.cameraPosition.xyz, orthoDir, uniforms.isOrtho != 0u);
        let dir = normalize(quatRotateInvF(uniforms.modelRotation, viewDir));
        var sh: array<half3, SH_COEFFS>;
        var shScale: f32;
        readSHData(&sh, &shScale);
        color += vec3f(evalSH(&sh, dir) * half(shScale));
    #endif
    return color;
}
`;
    }
    bindFormats() {
        const format = this.require().format;
        const entries = format.getComputeBindFormats();
        for (const entry of entries) {
            const stream = format.streams.find((s) => s.name === entry.name);
            if (stream?.format === PIXELFORMAT_RGBA32F)
                entry.sampleType = SAMPLETYPE_UNFILTERABLE_FLOAT;
        }
        return entries;
    }
    shaderIncludes() {
        // the read chunks include the engine's own gsplat chunks by name
        return new Map(ShaderChunks.get(this.device, SHADERLANGUAGE_WGSL));
    }
    shaderDefines() {
        const defines = new Map();
        this.require().configureMaterialDefines(defines);
        return defines;
    }
    chunkBase(node) {
        return node.sourceBase;
    }
    dispatchPlan(set) {
        // one run of the chunk table per file (the table is built file by file)
        const groups = [];
        let chunkBase = 0;
        const hash = this.resource?.format.hash;
        for (const file of set.files) {
            let chunkCount = 0;
            for (const node of file.nodes)
                chunkCount += Math.ceil(node.count / 256);
            if (chunkCount > 0 && file.resource.format.hash === hash) {
                groups.push({ fileIndex: file.fileIndex, chunkBase, chunkCount });
            }
            chunkBase += chunkCount;
        }
        return groups;
    }
    bind(compute, group, set) {
        const file = set.files[group.fileIndex];
        const { resource } = file;
        for (const [name, texture] of resource.streams.textures) {
            compute.setParameter(name, texture);
        }
        for (const [name, value] of resource.parameters) {
            compute.setParameter(name, value);
        }
        const constants = this.constants.get(file.fileIndex);
        compute.setParameter('model', file.modelMatrix.data);
        compute.setParameter('modelRotation', constants.rotation);
        compute.setParameter('modelScale', constants.scale);
    }
    textureSize(group) {
        return this.set?.files[group.fileIndex].resource.textureDimensions.x ?? 0;
    }
    gpuBytes() {
        // the file textures belong to the engine and are counted by app.stats.vram
        return 0;
    }
    shaderKey() {
        const resource = this.resource;
        if (!resource)
            return 'direct:';
        const defines = this.shaderDefines();
        return `direct:${resource.format.hash}:${[...defines].map(([k, v]) => `${k}=${v}`).join(',')}`;
    }
    destroy() {
        this.restoreWorkBuffer();
        this.resource = null;
        this.set = null;
        this.constants.clear();
    }
    require() {
        if (!this.resource)
            throw new Error('DirectSplatSource: update() has not run');
        return this.resource;
    }
}

class WorkBufferSplatSource {
    kind = 'workbuffer';
    workBuffer = null;
    update(set, manager) {
        this.workBuffer = manager.world.workBuffer;
    }
    readChunk(bindingBase) {
        const format = this.require().format;
        // the engine's declarations bind one texture per stream from bindingBase and define
        // loadDataX(); its read code decodes them into getCenter() and friends, already in
        // world space with the sh colour baked for this camera
        return /* wgsl */ `
${format.getComputeInputDeclarations(bindingBase)}
${format.getReadCode()}
fn srcCenter() -> vec3f { return getCenter(); }
fn srcOpacity() -> f32 { return getOpacity(); }
fn srcRotation() -> vec4f { return getRotation(); }
fn srcScale() -> vec3f { return getScale(); }
fn srcColor() -> vec3f { return getColor(); }
`;
    }
    bindFormats() {
        return this.require().format.getComputeBindFormats();
    }
    shaderIncludes() {
        return undefined;
    }
    shaderDefines() {
        return undefined;
    }
    chunkBase(node) {
        return node.slotBase;
    }
    dispatchPlan(set, numChunks) {
        return [{ fileIndex: -1, chunkBase: 0, chunkCount: numChunks }];
    }
    bind(compute) {
        const workBuffer = this.require();
        for (const stream of workBuffer.format.streams) {
            compute.setParameter(stream.name, workBuffer.getTexture(stream.name));
        }
    }
    textureSize() {
        return this.require().textureSize;
    }
    gpuBytes() {
        // the work buffer belongs to the engine and is counted by app.stats.vram
        return 0;
    }
    shaderKey() {
        const workBuffer = this.workBuffer;
        return workBuffer ? `wb:${workBuffer.format.streams.map((s) => s.name).join(',')}` : 'wb:';
    }
    destroy() {
        this.workBuffer = null;
    }
    require() {
        if (!this.workBuffer)
            throw new Error('WorkBufferSplatSource: update() has not run');
        return this.workBuffer;
    }
}

// The stochastic splat renderer (WebGPU, opt-in). The engine keeps LOD, streaming and the
// work-buffer copy; this owns everything after: per frame it culls nodes on the cpu, projects
// the resident splats in a compute pass into a dense cache, writes the indirect draw arguments,
// rasterises the survivors as opaque depth-tested quads into its own colour + depth target
// (StochasticSplats: keep a fragment with probability alpha, no sort), and composes that target
// over the camera's target from a fullscreen quad in the World layer that also writes depth.
//
// Frame flow: the compute runs inside the engine's gsplat update (the `frame:ready` hook, before
// the frame graph), the raster pass runs from `camera.beforePasses`, and the compose is an
// ordinary mesh instance in the camera's forward pass. See docs/stochastic-renderer.md.
const defaultVariant = () => ({
    spp: 'quad',
    compose: 'blend',
    cull: 'auto',
    order: 'bucket',
    contribution: 0,
    popless: 'on',
    taa: 'on',
    taaMax: 256,
    taaMoveMax: 16,
    taaClip: 1.25,
    taaFilter: 'cubic',
    taaReproj: 'sample',
    taaMotion: 4,
    taaDebug: 0,
    taaFlip: 0,
    colorMax: 8,
    units: 'engine'
});
const taaCount = (value) => Math.min(TAA_MAX_COUNT, Math.max(1, Math.round(value)));
const parseVariant = (text) => {
    const variant = defaultVariant();
    for (const part of (text ?? '').split(',')) {
        const [key, value] = part.split(':').map((s) => s.trim());
        if (!key || value === undefined)
            continue;
        if (key === 'spp' && (value === '1' || value === 'quad'))
            variant.spp = value;
        if (key === 'compose' && (value === 'blend' || value === 'none' || value === 'depth'))
            variant.compose = value;
        if (key === 'popless' && (value === 'on' || value === 'off'))
            variant.popless = value;
        if (key === 'taa' && (value === 'on' || value === 'off'))
            variant.taa = value;
        if (key === 'taaMax' && Number.isFinite(Number(value)))
            variant.taaMax = taaCount(Number(value));
        if (key === 'taaMoveMax' && Number.isFinite(Number(value)))
            variant.taaMoveMax = taaCount(Number(value));
        if (key === 'taaDebug' && Number.isFinite(Number(value)))
            variant.taaDebug = Number(value);
        if (key === 'taaClip' && Number.isFinite(Number(value)))
            variant.taaClip = Math.max(0, Number(value));
        if (key === 'taaFilter' && (value === 'linear' || value === 'cubic'))
            variant.taaFilter = value;
        if (key === 'taaReproj' && (value === 'sample' || value === 'history'))
            variant.taaReproj = value;
        if (key === 'taaMotion' && Number.isFinite(Number(value)))
            variant.taaMotion = Math.max(0, Number(value));
        if (key === 'taaFlip' && Number.isFinite(Number(value)))
            variant.taaFlip = Number(value);
        if (key === 'colorMax' && Number.isFinite(Number(value)))
            variant.colorMax = Math.max(0, Number(value));
        if (key === 'units' && (value === 'px' || value === 'engine'))
            variant.units = value;
        if (key === 'cull' && (value === 'off' || value === 'l1' || value === 'l2' || value === 'auto')) {
            variant.cull = value;
        }
        if (key === 'order' && (value === 'append' || value === 'bucket'))
            variant.order = value;
        if (key === 'contribution' && Number.isFinite(Number(value)))
            variant.contribution = Math.max(0, Number(value));
    }
    return variant;
};
// Renders an explicit mesh-instance list into the renderer's own target (the raster and the
// taa resolve). Not a layer: a layer in camera.layers is culled once and drawn by every pass
// for the camera, so the scene pass would draw the splats into the camera target as well.
class SplatRasterPass extends RenderPass {
    forward;
    camera;
    instances;
    constructor(device, forward, camera, instances, name = 'sse-splat-raster') {
        super(device);
        this.forward = forward;
        this.camera = camera;
        this.instances = instances;
        this.name = name;
    }
    execute() {
        this.forward.renderForwardLayer(this.camera.camera, this.renderTarget, null, undefined, SHADER_FORWARD, {
            meshInstances: this.instances
        });
    }
}
const createQuadMesh = (device, quads) => {
    const positions = new Float32Array(quads * 4 * 3);
    const indices = new Uint32Array(quads * 6);
    for (let i = 0; i < quads; ++i) {
        // z carries the quad's index within the instance
        positions.set([-1, -1, i, 1, -1, i, 1, 1, i, -1, 1, i], i * 12);
        const v = i * 4;
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const mesh = new Mesh(device);
    mesh.setPositions(positions, 3);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};
const createFullscreenMesh = (device) => {
    const mesh = new Mesh(device);
    mesh.setPositions(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2);
    mesh.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};
const tmpVec2 = new Vec2();
class StochasticSplatRenderer {
    variant;
    source;
    app;
    device;
    camera;
    worldLayer;
    provider;
    unsubscribe;
    enabled = true;
    // the resident set and its chunk table
    set = null;
    numChunks = 0;
    chunkData = new Uint32Array(0);
    chunkBuffer = null;
    nodeVisibleData = new Uint32Array(0);
    nodeVisibleBuffer = null;
    cacheBuffer = null;
    cacheSlots = 0;
    counter;
    // compute
    // one projector shader per source and occlusion / order specialisation: the test's code
    // costs a little even when a uniform disables it, so a disabled or suspended cull runs
    // without it. One compute per shader and dispatch group, since a compute owns the uniform
    // buffer its dispatch reads and per-file sources dispatch once per file
    projectorShaders = new Map();
    projectorComputes = new Map();
    projectorBindGroupFormat = null;
    projectorSourceKey = '';
    args;
    argsBindGroupFormat;
    // order:bucket: bucket counts then offsets, the ordered slot list, and its two passes
    orderBuckets;
    orderedBuffer = null;
    orderScan;
    orderScatter;
    orderFormats = [];
    // the occlusion grid: farthest depth per 8 px block (level 1) and per 32 px block (level 2)
    occL1;
    occL2;
    occBlocks = { x1: 0, y1: 0, x2: 0, y2: 0 };
    reduceL1;
    reduceL2;
    reduceFormats = [];
    // the previous frame the grid and the reprojection describe; valid only when that frame
    // rendered to the same target at the same size from the same world state
    prevValid = false;
    prevViewProjection = new Mat4();
    prevView = new Mat4();
    prevProjection = new Mat4();
    prevClipZ = [0, 0, 0, 0];
    prevViewport = [0, 0];
    prevFocal = [0, 0];
    prevFlip = 1;
    prevWidth = 0;
    prevHeight = 0;
    prevVersion = -1;
    // the allocations resident when the previous frame drew, and whether any of them has gone
    // since: only a removed splat can make the previous depth wrong (it may have hidden what is
    // now behind it), so arrivals leave the cull on while a scene streams in
    residentAllocIds = new Set();
    nodesRemoved = false;
    prevOrtho = false;
    /** Whether the last frame ran the occlusion cull, for the debug panel and the harness. */
    culling = false;
    /** Whether cull:auto currently has the test switched off for culling too little. */
    get cullSuspended() {
        return this.variant.cull === 'auto' && (!this.cullActive || this.cullSuspendedFrames > 0);
    }
    // cull:auto bookkeeping. The last decision holds while a readback is in flight: while the
    // test is active every culled frame's counts are read back and a poor one suspends it;
    // while suspended the frames count down, then one probe frame runs the test and the rest
    // wait for its counts
    cullActive = true;
    cullSuspendedFrames = 0;
    cullStatsPending = false;
    /** Frames the test stays off after culling too little (cull:auto). */
    /**
     * Whether the projected cache for `splats` resident splats fits one storage binding on this
     * device. The cache reserves 25% over the resident count; adapters differ in the limit
     * (128 MiB is the WebGPU default), so a viewer checks before opting in.
     */
    static cacheFits(device, splats) {
        const limit = device.wgpu?.limits
            ?.maxStorageBufferBindingSize;
        return !limit || Math.ceil(splats * 1.25) * CACHE_WORDS * 4 <= limit;
    }
    static CULL_SUSPEND_FRAMES = 60;
    /** The culled fraction below which cull:auto suspends the test. */
    static CULL_MIN_FRACTION = 0.08;
    /**
     * Let a capture (query) frame cull against the previous on-screen frame when it renders at
     * the same size. Off by default: a query frame is not culled, since its cull thins what a
     * pick or a thumbnail should see. The harness turns it on to photograph culled frames.
     */
    allowQueryCull = false;
    // raster
    colorTexture;
    depthTexture;
    target;
    rasterMesh;
    rasterMaterial;
    rasterInstance;
    rasterPass;
    // taa: ping-pong history (premultiplied colour + coverage as unorm16, and the depth mean and
    // sample count packed in 32 bits; shaders/taa.ts), resolved by a fullscreen pass after the
    // raster. Sized with the target on the first accumulating frame, and shrunk back while taa is off
    taaColor = [];
    taaInfo = [];
    taaTargets = [];
    taaWrite = 0;
    taaMesh;
    taaMaterial;
    taaInstance;
    taaPass;
    // whether the history holds the previous on-screen frame at the current size
    taaHistoryValid = false;
    // the previous taa frame's matrices as the pass reads them, and this frame's, copied over
    // at the start of the next frame: the material holds the data arrays by reference and
    // uploads them when it draws, after this hook has run
    taaPrevViewProjection = new Mat4();
    taaPrevView = new Mat4();
    taaLastViewProjection = new Mat4();
    taaLastView = new Mat4();
    taaWidth = 0;
    taaHeight = 0;
    // the camera's world transform, for the accumulation's reprojection
    cameraWorld = new Mat4();
    // frames since the camera or the scene last changed, for converging at rest
    restFrames = 0;
    /** The frame the depth texture holds, null while it holds a capture's or nothing. */
    depthFrame = null;
    depthFrameCount = 0;
    depthFrameCamera = createPickCameraSnapshot();
    // a frame requested from inside the render: the engine clears app.renderNextFrame right
    // after render(), so the request is applied on frameend instead
    frameWanted = false;
    onFrameEnd = () => {
        if (this.frameWanted) {
            this.frameWanted = false;
            this.app.renderNextFrame = true;
        }
    };
    frameIndex = 0;
    // the seed the harness sets; the frame index replaces it while taa accumulates
    userSeed = 0;
    /** Whether the last frame ran the temporal accumulation, for the debug panel. */
    taaActive = false;
    /**
     * Let a capture (query) frame at the on-screen size run the accumulation over the on-screen
     * history, so the harness can photograph converged and moving frames. Off by default.
     */
    allowQueryTaa = false;
    // compose
    composeMesh;
    composeMaterial;
    composeInstance;
    frustum = new Frustum();
    sphere = new BoundingSphere();
    shaderProjection = new Mat4();
    viewProjection = new Mat4();
    frameSeed = 0;
    ready = false;
    /** Byte sizes of the buffers this renderer owns, for the bench harness and the debug panel. */
    /** The renderer's depth texture: the nearest surviving sample per pixel of `depthFrame`. */
    get frameDepthTexture() {
        return this.depthTexture;
    }
    get gpuBytes() {
        const buffers = [
            this.chunkBuffer,
            this.nodeVisibleBuffer,
            this.cacheBuffer,
            this.orderedBuffer,
            this.counter,
            this.orderBuckets,
            this.occL1,
            this.occL2
        ];
        let bytes = 0;
        for (const buffer of buffers)
            bytes += buffer?.byteSize ?? 0;
        bytes += this.colorTexture.gpuSize + this.depthTexture.gpuSize;
        for (const texture of [...this.taaColor, ...this.taaInfo])
            bytes += texture.gpuSize;
        return bytes + this.source.gpuBytes();
    }
    /**
     * The seed mixed into every coverage hash. 0 makes a still camera reproduce its frame;
     * the harness varies it to measure the sampling noise floor, and TAA will animate it.
     */
    get seed() {
        return this.frameSeed;
    }
    set seed(value) {
        this.userSeed = value >>> 0;
        this.frameSeed = this.userSeed;
        this.app.renderNextFrame = true;
    }
    /** The last projected frame's survivor count and occlusion-culled count, read back from the gpu. */
    async readStats() {
        // without a typed array the engine hands back bytes
        const data = new Uint32Array(2);
        await this.counter.read(0, 8, data, true);
        return { survivors: data[0], occluded: data[1] };
    }
    // reduce the previous frame's depth into the two grid levels
    reduceDepth(width, height) {
        const { device } = this;
        const x1 = Math.ceil(width / 8);
        const y1 = Math.ceil(height / 8);
        const x2 = Math.ceil(x1 / 4);
        const y2 = Math.ceil(y1 / 4);
        if (this.occBlocks.x1 !== x1 || this.occBlocks.y1 !== y1) {
            this.occL1.destroy();
            this.occL2.destroy();
            this.occL1 = new StorageBuffer(device, x1 * y1 * 4, BUFFERUSAGE_COPY_DST);
            this.occL2 = new StorageBuffer(device, x2 * y2 * 4, BUFFERUSAGE_COPY_DST);
            this.occBlocks = { x1, y1, x2, y2 };
        }
        const l1 = this.reduceL1;
        l1.setParameter('prevDepth', this.depthTexture);
        l1.setParameter('blockMax', this.occL1);
        l1.setParameter('width', width);
        l1.setParameter('height', height);
        l1.setParameter('blocksX', x1);
        l1.setParameter('blocksY', y1);
        l1.setupDispatch(x1, y1, 1);
        const l2 = this.reduceL2;
        l2.setParameter('level1', this.occL1);
        l2.setParameter('level2', this.occL2);
        l2.setParameter('blocksX1', x1);
        l2.setParameter('blocksY1', y1);
        l2.setParameter('blocksX2', x2);
        l2.setParameter('blocksY2', y2);
        Compute.calcDispatchSize(Math.ceil((x2 * y2) / 64), tmpVec2);
        l2.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
        device.computeDispatch([l1], 'sse-splat-reduce1');
        device.computeDispatch([l2], 'sse-splat-reduce2');
    }
    /** Survivors of the last frame's projection are only known to the gpu; this is the resident count. */
    activeSplats = 0;
    constructor(app, camera, worldLayer, options = {}) {
        this.app = app;
        this.device = app.graphicsDevice;
        this.camera = camera;
        this.worldLayer = worldLayer;
        this.variant = parseVariant(options.variant);
        const { device } = this;
        if (options.source === 'direct') {
            this.source = new DirectSplatSource(device);
        }
        else {
            if (options.source && options.source !== 'workbuffer') {
                console.warn(`StochasticSplatRenderer: splat source '${options.source}' is not implemented yet, using the work buffer`);
            }
            this.source = new WorkBufferSplatSource();
        }
        this.counter = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
        // indirect draw arguments
        this.argsBindGroupFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDrawArgs', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('indirectDispatchArgs', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.args = new Compute(device, new Shader(device, {
            name: 'sse-splat-args',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: argsWGSL,
            computeUniformBufferFormats: {
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('drawSlot', UNIFORMTYPE_UINT),
                    new UniformFormat('indexCount', UNIFORMTYPE_UINT),
                    new UniformFormat('quadsPerInstance', UNIFORMTYPE_UINT),
                    new UniformFormat('dispatchSlot', UNIFORMTYPE_UINT),
                    new UniformFormat('scatterWorkgroupSize', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: this.argsBindGroupFormat
        }), 'sse-splat-args');
        // the ordering passes
        this.orderBuckets = new StorageBuffer(device, 2 * ORDER_BUCKETS * 4, BUFFERUSAGE_COPY_DST);
        const scanFormat = new BindGroupFormat(device, [new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE)]);
        const scatterFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('ordered', SHADERSTAGE_COMPUTE)
        ]);
        this.orderFormats = [scanFormat, scatterFormat];
        this.orderScan = new Compute(device, new Shader(device, {
            name: 'sse-splat-order-scan',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: orderScanWGSL,
            computeBindGroupFormat: scanFormat
        }), 'sse-splat-order-scan');
        this.orderScatter = new Compute(device, new Shader(device, {
            name: 'sse-splat-order-scatter',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: orderScatterWGSL,
            computeBindGroupFormat: scatterFormat
        }), 'sse-splat-order-scatter');
        // the occlusion grid and its two reduce passes
        this.occL1 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        this.occL2 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        const reduceL1Format = new BindGroupFormat(device, [
            new BindTextureFormat('prevDepth', SHADERSTAGE_COMPUTE, TEXTUREDIMENSION_2D, SAMPLETYPE_DEPTH, false),
            new BindStorageBufferFormat('blockMax', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const reduceL2Format = new BindGroupFormat(device, [
            new BindStorageBufferFormat('level1', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('level2', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.reduceFormats = [reduceL1Format, reduceL2Format];
        this.reduceL1 = new Compute(device, new Shader(device, {
            name: 'sse-splat-reduce1',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: reduceL1WGSL,
            computeUniformBufferFormats: {
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('width', UNIFORMTYPE_UINT),
                    new UniformFormat('height', UNIFORMTYPE_UINT),
                    new UniformFormat('blocksX', UNIFORMTYPE_UINT),
                    new UniformFormat('blocksY', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: reduceL1Format
        }), 'sse-splat-reduce1');
        this.reduceL2 = new Compute(device, new Shader(device, {
            name: 'sse-splat-reduce2',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: reduceL2WGSL,
            computeUniformBufferFormats: {
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('blocksX1', UNIFORMTYPE_UINT),
                    new UniformFormat('blocksY1', UNIFORMTYPE_UINT),
                    new UniformFormat('blocksX2', UNIFORMTYPE_UINT),
                    new UniformFormat('blocksY2', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: reduceL2Format
        }), 'sse-splat-reduce2');
        // the raster target: colour, and a depth texture the compose, the occlusion cull and
        // (later) the picker read
        this.colorTexture = new Texture(device, {
            name: 'sse-splat-color',
            width: 4,
            height: 4,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.depthTexture = new Texture(device, {
            name: 'sse-splat-depth',
            width: 4,
            height: 4,
            format: PIXELFORMAT_DEPTH,
            mipmaps: false,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.target = new RenderTarget({
            name: 'sse-splat-target',
            colorBuffer: this.colorTexture,
            depthBuffer: this.depthTexture,
            samples: 1
        });
        this.rasterMesh = createQuadMesh(device, QUADS_PER_INSTANCE);
        this.rasterMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-raster',
            vertexWGSL: rasterVertexWGSL,
            fragmentWGSL: rasterFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.rasterMaterial.blendType = BLEND_NONE;
        this.rasterMaterial.depthWrite = true;
        this.rasterMaterial.depthTest = true;
        this.rasterMaterial.cull = CULLFACE_NONE;
        // the forward renderer reads the instance's node for its cull setup and world transform
        this.rasterInstance = new MeshInstance(this.rasterMesh, this.rasterMaterial, new GraphNode('sse-splat-raster'));
        this.rasterInstance.cull = false;
        this.rasterInstance.castShadow = false;
        this.rasterInstance.receiveShadow = false;
        this.rasterPass = new SplatRasterPass(device, app.renderer, camera, [
            this.rasterInstance
        ]);
        this.rasterPass.init(this.target);
        this.rasterPass.setClearColor(new Color(0, 0, 0, 0));
        this.rasterPass.setClearDepth(1);
        // nothing to draw, and no buffers bound, until the first populated frame
        this.rasterPass.enabled = false;
        // the taa resolve: a fullscreen pass from the raster target and the previous history
        // into the other history, sized with the target on its first frame
        for (let i = 0; i < 2; i++) {
            this.taaColor.push(new Texture(device, {
                name: `sse-splat-taa-color-${i}`,
                width: 4,
                height: 4,
                format: PIXELFORMAT_RGBA16U,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            }));
            this.taaInfo.push(new Texture(device, {
                name: `sse-splat-taa-info-${i}`,
                width: 4,
                height: 4,
                format: PIXELFORMAT_R32U,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            }));
            this.taaTargets.push(new RenderTarget({
                name: `sse-splat-taa-${i}`,
                colorBuffers: [this.taaColor[i], this.taaInfo[i]],
                depth: false,
                samples: 1
            }));
        }
        this.taaMesh = createFullscreenMesh(device);
        this.taaMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-taa',
            vertexWGSL: taaVertexWGSL,
            fragmentWGSL: taaFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION },
            fragmentOutputTypes: ['uvec4', 'uint']
        });
        this.taaMaterial.blendType = BLEND_NONE;
        this.taaMaterial.depthWrite = false;
        this.taaMaterial.depthTest = false;
        this.taaMaterial.cull = CULLFACE_NONE;
        this.taaInstance = new MeshInstance(this.taaMesh, this.taaMaterial, new GraphNode('sse-splat-taa'));
        this.taaInstance.cull = false;
        this.taaInstance.castShadow = false;
        this.taaInstance.receiveShadow = false;
        this.taaPass = new SplatRasterPass(device, app.renderer, camera, [this.taaInstance], 'sse-splat-taa');
        this.taaPass.init(this.taaTargets[0]);
        this.taaPass.enabled = false;
        // the compose quad, blended over the skybox and opaque meshes with the splat depth
        this.composeMesh = createFullscreenMesh(device);
        this.composeMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-compose',
            vertexWGSL: composeVertexWGSL,
            fragmentWGSL: composeFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.composeMaterial.blendType = BLEND_PREMULTIPLIED;
        this.composeMaterial.depthWrite = true;
        this.composeMaterial.depthTest = true;
        this.composeMaterial.cull = CULLFACE_NONE;
        this.composeMaterial.setParameter('splatColor', this.colorTexture);
        this.composeMaterial.setParameter('splatDepth', this.depthTexture);
        // always bound, even while taa is off: a declared texture without a value makes the
        // engine create and upload a placeholder inside the forward pass, which submits the
        // command buffer mid-pass on WebGPU
        this.composeMaterial.setParameter('taaColor', this.taaColor[0]);
        this.composeMaterial.setParameter('taaInfo', this.taaInfo[0]);
        this.composeInstance = new MeshInstance(this.composeMesh, this.composeMaterial, new GraphNode('sse-splat-compose'));
        this.composeInstance.cull = false;
        this.composeInstance.castShadow = false;
        this.composeInstance.receiveShadow = false;
        // the picker pass draws every pickable instance of the layer into a target without a
        // depth attachment; this shader writes frag_depth, which makes that pipeline invalid
        // and drops the whole submit, the frame's command buffer included
        this.composeInstance.pick = false;
        // first among the transparents, whichever way the layer sorts them
        this.composeInstance.drawOrder = -1e3;
        this.composeInstance.calculateSortDistance = () => Number.MAX_VALUE;
        this.applyVariant();
        this.provider = new EngineResidentSetProvider(app, camera, worldLayer);
        this.unsubscribe = this.provider.onFrame((set, changed, manager) => this.frame(set, changed, manager));
        app.on('frameend', this.onFrameEnd);
        this.attach();
    }
    /** Switch the renderer off and hand the splats back to the engine's renderer (XR), or on again. */
    setEnabled(value) {
        if (this.enabled === value)
            return;
        this.enabled = value;
        if (value) {
            this.attach();
        }
        else {
            this.detach();
        }
        this.app.renderNextFrame = true;
    }
    /** Replace the experiment switches from a `key:value,key:value` string (unset keys reset). */
    setVariant(text) {
        Object.assign(this.variant, parseVariant(text));
        // the cull decides afresh under new switches
        this.cullActive = true;
        this.cullSuspendedFrames = 0;
        this.applyVariant();
    }
    /**
     * Drop the temporal history; the next frame starts accumulating from its own sample. The
     * coverage seeds restart too, so a variant accumulates the same samples every time (the
     * harness compares builds image for image).
     */
    resetHistory() {
        this.taaHistoryValid = false;
        this.restFrames = 0;
        this.frameIndex = 0;
    }
    /** Re-read {@link variant} after a field changed. */
    applyVariant() {
        // a switch changes what the frames hold; an old history would leak into the new ones
        this.resetHistory();
        const quad = this.variant.spp === 'quad';
        this.rasterMaterial.setDefine('SSE_SPP_QUAD', quad ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_ORDERED', this.variant.order === 'bucket' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_POPLESS', this.variant.popless === 'on' ? '' : undefined);
        this.composeMaterial.setDefine('SSE_SHOW_DEPTH', this.variant.compose === 'depth' ? '' : undefined);
        this.composeMaterial.setDefine('SSE_SPP_QUAD', quad ? '' : undefined);
        this.rasterMaterial.update();
        this.composeMaterial.update();
        this.setReady(this.ready);
        this.app.renderNextFrame = true;
    }
    // the raster pass and the compose only run once a frame has bound the buffers they read
    setReady(value) {
        this.ready = value;
        this.rasterPass.enabled = value;
        this.composeInstance.visible = value && this.variant.compose !== 'none';
    }
    attach() {
        const passes = this.camera.camera.beforePasses;
        if (!passes.includes(this.rasterPass))
            passes.push(this.rasterPass);
        if (!passes.includes(this.taaPass))
            passes.push(this.taaPass);
        this.worldLayer.addMeshInstances([this.composeInstance]);
        this.provider.setActive(true);
    }
    detach() {
        const passes = this.camera.camera.beforePasses;
        for (const pass of [this.rasterPass, this.taaPass]) {
            const index = passes.indexOf(pass);
            if (index >= 0)
                passes.splice(index, 1);
        }
        this.resetHistory();
        this.depthFrame = null;
        this.worldLayer.removeMeshInstances([this.composeInstance]);
        this.provider.setActive(false);
    }
    frame(set, changed, manager) {
        if (!this.enabled)
            return;
        const { device, camera } = this;
        const cam = camera.camera;
        this.nodesRemoved = false;
        if (changed || this.set !== set) {
            const ids = new Set(set.nodes.map((node) => node.allocId));
            for (const id of this.residentAllocIds) {
                if (!ids.has(id)) {
                    this.nodesRemoved = true;
                    break;
                }
            }
            this.residentAllocIds = ids;
            this.source.update(set, manager);
            this.rebuildChunkTable(set);
            this.ensureCache(set.activeSplats);
            this.activeSplats = set.activeSplats;
            this.pruneProjectorComputes(set);
            // recorded last, so a rebuild that throws is retried next frame
            this.set = set;
        }
        if (this.numChunks === 0) {
            // nothing resident: draw nothing
            this.setReady(false);
            return;
        }
        // the target follows whatever the camera renders into this frame: the backbuffer, or a
        // capture's render target at another size
        const rt = camera.renderTarget;
        const width = rt ? rt.width : device.width;
        const height = rt ? rt.height : device.height;
        if (this.target.width !== width || this.target.height !== height) {
            this.target.resize(width, height);
        }
        const view = cam.viewMatrix;
        const projection = cam.projectionMatrix;
        const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
        // the clip z the raster shader reconstructs must match the engine's WebGPU depth range
        const shaderProjection = Camera$1.applyShaderProjectionTransform(projection, this.shaderProjection, false, true);
        this.viewProjection.mul2(shaderProjection, view);
        // The splats' own depth: clip z = a * depth + b (over w = depth for a perspective
        // camera). The camera's far plane is fitted to the scene bound, which can leave a sky
        // outside it, and splats clamped there share one depth and lose their order; so a
        // perspective raster puts its far plane at infinity (z = 1 - near / depth), with the same
        // near plane and, near where precision matters, the same resolution. The compose converts
        // back to the camera's depth where the splats meet the rest of the scene. An orthographic
        // camera keeps its own mapping: a linear depth has no far plane at infinity.
        const cameraClipZ = [-shaderProjection.data[10], shaderProjection.data[14]];
        const clipZ = isOrtho ? cameraClipZ : [1, cameraClipZ[1] / cameraClipZ[0]];
        const clipZParams = [clipZ[0], clipZ[1], isOrtho ? 1 : 0, 0];
        this.cullNodes(set, this.viewProjection);
        const focal = [Math.abs(projection.data[0]) * width * 0.5, Math.abs(projection.data[5]) * height * 0.5];
        const gsplat = this.app.scene.gsplat;
        // the moving-camera contribution cull: a raised threshold while the view changes, then
        // one more frame at the scene's threshold once it has stopped
        const moved = this.viewMoved(view, projection);
        const raised = moved && this.variant.contribution > 0;
        const minContribution = raised
            ? Math.max(gsplat.minContribution, this.variant.contribution)
            : gsplat.minContribution;
        if (raised)
            this.frameWanted = true;
        // Temporal accumulation runs on on-screen frames (and, for the harness, on a capture at
        // the same size); the history is only trusted when it holds the previous such frame at
        // this size. While it runs the coverage seed changes every frame, and a resting camera
        // keeps requesting frames until the history has filled its cap
        const isQuery = !!rt;
        const taaOn = this.variant.taa === 'on' &&
            (!isQuery || (this.allowQueryTaa && width === this.taaWidth && height === this.taaHeight));
        if (taaOn) {
            if (this.taaWidth !== width || this.taaHeight !== height) {
                this.resizeHistory(width, height);
                this.taaWidth = width;
                this.taaHeight = height;
                this.taaHistoryValid = false;
                this.restFrames = 0;
            }
            this.frameSeed = this.frameIndex++ >>> 0;
            if (moved || changed)
                this.restFrames = 0;
            else
                this.restFrames++;
            if (this.restFrames < this.variant.taaMax + 2)
                this.frameWanted = true;
        }
        else {
            this.frameSeed = this.userSeed;
            // a capture at another size does not accumulate; the next on-screen frame starts over
            this.taaHistoryValid = false;
            this.restFrames = 0;
            // switched off: the history goes back to its placeholder size until it is wanted
            if (this.variant.taa === 'off' && this.taaWidth !== 0) {
                this.resizeHistory(4, 4);
                this.taaWidth = 0;
                this.taaHeight = 0;
            }
        }
        this.taaActive = taaOn;
        // The occlusion cull reads the depth texture as the previous frame left it, so it needs
        // that frame to have drawn to this target at this size (a resize loses the texture, a
        // capture draws elsewhere), with no splat removed since (its depth would hide what is
        // now behind it; arrivals are safe) and the same projection type. A capture frame is
        // never culled and never becomes the previous frame.
        // a new world state can change what is occluded: try the test again
        if (this.prevVersion !== set.version) {
            this.cullSuspendedFrames = 0;
            this.cullActive = true;
        }
        const cullMode = this.variant.cull;
        let wanted = cullMode !== 'off';
        let probe = false;
        if (cullMode === 'auto' && !isQuery) {
            if (this.cullSuspendedFrames > 0) {
                // a moving camera changes what is occluded, so the probe comes sooner
                const moved = this.viewMoved(view, projection);
                this.cullSuspendedFrames = Math.max(0, this.cullSuspendedFrames - (moved ? 4 : 1));
                wanted = false;
            }
            else if (!this.cullActive) {
                // suspended and due: one probe frame, then wait for its counts
                probe = !this.cullStatsPending;
                wanted = probe;
            }
        }
        const culling = wanted &&
            (!isQuery || this.allowQueryCull) &&
            this.prevValid &&
            this.prevWidth === width &&
            this.prevHeight === height &&
            !this.nodesRemoved &&
            this.prevOrtho === isOrtho;
        this.culling = culling;
        if (culling) {
            this.reduceDepth(width, height);
        }
        this.counter.clear();
        const ordered = this.variant.order === 'bucket';
        if (ordered)
            this.orderBuckets.clear();
        // the order key spans the fitted clip range, log-spaced
        const logNear = Math.log(Math.max(cam.nearClip, 1e-6));
        const invLogRange = 1 / Math.max(Math.log(Math.max(cam.farClip, 1e-6)) - logNear, 1e-6);
        // the view depths where the raster's clip z reaches 0 and its far clamp (FAR_CLIP_Z), from
        // clip z = a * depth + b (over w = depth for a perspective camera)
        const [clipA, clipB] = clipZ;
        const depthNear = -clipB / clipA;
        const depthFar = isOrtho ? (FAR_CLIP_Z - clipB) / clipA : clipB / (FAR_CLIP_Z - clipA);
        const cameraPosition = camera.entity.getPosition();
        const groups = this.source.dispatchPlan(set, this.numChunks);
        for (const group of groups) {
            // a file with no node in the frustum has nothing to dispatch
            if (group.fileIndex >= 0 && !this.anyNodeVisible(set.files[group.fileIndex].nodes))
                continue;
            const projector = this.ensureProjector(culling, ordered, group);
            this.source.bind(projector, group, set);
            projector.setParameter('chunks', this.chunkBuffer);
            projector.setParameter('nodeVisible', this.nodeVisibleBuffer);
            projector.setParameter('cache', this.cacheBuffer);
            projector.setParameter('counter', this.counter);
            projector.setParameter('occL1', this.occL1);
            projector.setParameter('occL2', this.occL2);
            projector.setParameter('buckets', this.orderBuckets);
            projector.setParameter('view', view.data);
            projector.setParameter('viewProj', this.viewProjection.data);
            projector.setParameter('prevViewProj', this.prevViewProjection.data);
            projector.setParameter('prevView', this.prevView.data);
            projector.setParameter('prevClipZ', this.prevClipZ);
            projector.setParameter('viewport', [width, height]);
            projector.setParameter('focal', focal);
            projector.setParameter('prevViewport', this.prevViewport);
            projector.setParameter('prevFocal', this.prevFocal);
            projector.setParameter('numChunks', group.chunkCount);
            projector.setParameter('chunkBase', group.chunkBase);
            projector.setParameter('cameraPosition', [cameraPosition.x, cameraPosition.y, cameraPosition.z, 0]);
            projector.setParameter('splatTextureSize', this.source.textureSize(group));
            projector.setParameter('isOrtho', isOrtho ? 1 : 0);
            projector.setParameter('minPixelSize', gsplat.minPixelSize);
            projector.setParameter('alphaClip', gsplat.alphaClipForward);
            projector.setParameter('minContribution', minContribution);
            projector.setParameter('colorMax', this.variant.colorMax);
            projector.setParameter('unitScale', this.variant.units === 'engine' ? 2 : 1);
            projector.setParameter('occBlocksX1', this.occBlocks.x1);
            projector.setParameter('occBlocksY1', this.occBlocks.y1);
            projector.setParameter('occBlocksX2', this.occBlocks.x2);
            projector.setParameter('occBlocksY2', this.occBlocks.y2);
            projector.setParameter('occlusionMode', culling ? (cullMode === 'l1' ? 1 : 2) : 0);
            projector.setParameter('prevFlip', this.prevFlip);
            projector.setParameter('keyLogNear', logNear);
            projector.setParameter('keyInvLogRange', invLogRange);
            projector.setParameter('depthNear', depthNear);
            projector.setParameter('depthFar', depthFar);
            Compute.calcDispatchSize(group.chunkCount, tmpVec2);
            projector.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
            device.computeDispatch([projector], 'sse-splat-project');
        }
        // indirect draw arguments for the raster and dispatch size for the scatter; slots are
        // per frame
        const drawSlot = device.getIndirectDrawSlot(1);
        const dispatchSlot = device.getIndirectDispatchSlot(1);
        this.args.setParameter('counter', this.counter);
        this.args.setParameter('indirectDrawArgs', device.indirectDrawBuffer);
        this.args.setParameter('indirectDispatchArgs', device.indirectDispatchBuffer);
        this.args.setParameter('drawSlot', drawSlot);
        this.args.setParameter('indexCount', QUADS_PER_INSTANCE * 6);
        this.args.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
        this.args.setParameter('dispatchSlot', dispatchSlot);
        this.args.setParameter('scatterWorkgroupSize', ORDER_BUCKETS);
        this.args.setupDispatch(1, 1, 1);
        device.computeDispatch([this.args], 'sse-splat-args');
        this.rasterInstance.setIndirect(null, drawSlot, 1);
        if (ordered) {
            // bucket offsets, then every survivor claims its place in its bucket
            this.orderScan.setParameter('buckets', this.orderBuckets);
            this.orderScan.setupDispatch(1, 1, 1);
            device.computeDispatch([this.orderScan], 'sse-splat-order-scan');
            const scatter = this.orderScatter;
            scatter.setParameter('counter', this.counter);
            scatter.setParameter('cache', this.cacheBuffer);
            scatter.setParameter('buckets', this.orderBuckets);
            scatter.setParameter('ordered', this.orderedBuffer);
            scatter.setupIndirectDispatch(dispatchSlot);
            device.computeDispatch([scatter], 'sse-splat-order-scatter');
        }
        const material = this.rasterMaterial;
        material.setParameter('splatCache', this.cacheBuffer);
        material.setParameter('splatCount', this.counter);
        if (ordered)
            material.setParameter('orderedSlots', this.orderedBuffer);
        material.setParameter('viewportSize', [width, height, 2 / width, 2 / height]);
        material.setParameter('clipZParams', clipZParams);
        material.setParameter('focalParams', [focal[0], focal[1], 0, 0]);
        material.setParameter('sseAlphaClip', gsplat.alphaClipForward);
        material.setParameter('frameSeed', this.frameSeed);
        this.taaPass.enabled = taaOn;
        if (taaOn) {
            const read = this.taaWrite ^ 1;
            const taa = this.taaMaterial;
            this.taaPrevViewProjection.copy(this.taaLastViewProjection);
            this.taaPrevView.copy(this.taaLastView);
            this.cameraWorld.copy(view).invert();
            taa.setParameter('curColor', this.colorTexture);
            taa.setParameter('curDepth', this.depthTexture);
            taa.setParameter('histColor', this.taaColor[read]);
            taa.setParameter('histInfo', this.taaInfo[read]);
            taa.setParameter('cameraWorld', this.cameraWorld.data);
            // x_ndc = (m00 x + m02 z) / -z for a perspective camera, m00 x + m03 for an orthographic one
            const sp = shaderProjection.data;
            taa.setParameter('unproject', isOrtho ? [sp[0], sp[5], sp[12], sp[13]] : [sp[0], sp[5], sp[8], sp[9]]);
            taa.setParameter('prevViewProj', this.taaPrevViewProjection.data);
            taa.setParameter('prevView', this.taaPrevView.data);
            taa.setParameter('clipZParams', clipZParams);
            // a changed resident set (detail streamed in) keeps the history but caps its weight,
            // so the new content shows within taaMoveMax frames rather than 1 / taaMax a frame
            taa.setParameter('taaParams', [
                moved || changed ? this.variant.taaMoveMax : this.variant.taaMax,
                this.taaHistoryValid ? 1 : 0,
                moved ? 1 : 0,
                this.restFrames
            ]);
            taa.setParameter('taaViewport', [width, height, 1 / width, 1 / height]);
            taa.setParameter('taaControl', [
                this.variant.taaFlip || (this.target.flipY ? -1 : 1),
                this.variant.taaClip,
                this.variant.spp === 'quad' ? 1 : 0,
                0
            ]);
            taa.setParameter('taaDebug', this.variant.taaDebug);
            taa.setParameter('taaFilter', [
                this.variant.taaFilter === 'cubic' ? 1 : 0,
                this.variant.taaReproj === 'history' ? 1 : 0,
                this.variant.taaMotion,
                0
            ]);
            this.taaPass.renderTarget = this.taaTargets[this.taaWrite];
            this.composeMaterial.setParameter('taaColor', this.taaColor[this.taaWrite]);
            this.composeMaterial.setParameter('taaInfo', this.taaInfo[this.taaWrite]);
            this.taaLastViewProjection.copy(this.viewProjection);
            this.taaLastView.copy(view);
            this.taaHistoryValid = true;
            this.taaWrite ^= 1;
        }
        // an offscreen target's rows run the other way to the backbuffer's on WebGPU
        const targetFlipY = rt ? rt.flipY : device.backBuffer.flipY;
        this.composeMaterial.setParameter('composeParams', [
            this.target.flipY !== targetFlipY ? 1 : 0,
            isOrtho ? 1 : 0,
            taaOn ? 1 : 0,
            0
        ]);
        this.composeMaterial.setParameter('depthViewParams', [
            clipZ[0],
            clipZ[1],
            Math.max(cam.nearClip, 1e-4),
            Math.max(cam.farClip, cam.nearClip * 2)
        ]);
        this.composeMaterial.setParameter('cameraClipZ', [cameraClipZ[0], cameraClipZ[1], isOrtho ? 1 : 0, 0]);
        // cull:auto: read this culled frame's counts back (asynchronously, off the frame) and
        // keep the test only while it removes enough to pay for itself
        if (culling && cullMode === 'auto' && !isQuery && !this.cullStatsPending) {
            this.cullStatsPending = true;
            const data = new Uint32Array(2);
            this.counter
                .read(0, 8, data, false)
                .then(() => {
                const total = data[0] + data[1];
                const worthwhile = total > 0 && data[1] / total >= StochasticSplatRenderer.CULL_MIN_FRACTION;
                this.cullActive = worthwhile;
                if (!worthwhile)
                    this.cullSuspendedFrames = StochasticSplatRenderer.CULL_SUSPEND_FRAMES;
            })
                .catch(() => {
                // a lost device or a destroyed buffer; the next frame tries again
            })
                .finally(() => {
                this.cullStatsPending = false;
            });
        }
        // this frame becomes the previous one, unless it is a capture
        if (isQuery) {
            // the capture drew elsewhere; the on-screen depth texture is no longer this frame's
            this.prevValid = false;
            this.depthFrame = null;
            this.setReady(true);
            return;
        }
        captureCameraSnapshot(camera.entity, this.depthFrameCamera);
        this.depthFrame = {
            id: ++this.depthFrameCount,
            camera: this.depthFrameCamera,
            width,
            height,
            clipZ: [clipZ[0], clipZ[1]]
        };
        this.prevViewProjection.copy(this.viewProjection);
        this.prevView.copy(view);
        this.prevProjection.copy(projection);
        this.prevClipZ = clipZParams;
        this.prevViewport = [width, height];
        this.prevFocal = focal;
        this.prevFlip = this.target.flipY ? -1 : 1;
        this.prevWidth = width;
        this.prevHeight = height;
        this.prevVersion = set.version;
        this.prevOrtho = isOrtho;
        this.prevValid = !isQuery;
        this.setReady(true);
    }
    resizeHistory(width, height) {
        for (const texture of [...this.taaColor, ...this.taaInfo])
            texture.resize(width, height);
        for (const target of this.taaTargets)
            target.resize(width, height);
    }
    // whether the view or the projection differs from the previous on-screen frame's beyond
    // float noise (the camera controllers settle over many frames; a fov animation moves the
    // image without moving the camera)
    viewMoved(view, projection) {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(view.data[i] - this.prevView.data[i]) > 1e-6)
                return true;
            if (Math.abs(projection.data[i] - this.prevProjection.data[i]) > 1e-6)
                return true;
        }
        return false;
    }
    // one chunk-table entry per CHUNK_SIZE splats of every resident node
    rebuildChunkTable(set) {
        let count = 0;
        for (const node of set.nodes)
            count += Math.ceil(node.count / CHUNK_SIZE);
        if (this.chunkData.length < count * 4) {
            this.chunkData = new Uint32Array(Math.ceil(count * 1.25) * 4);
            this.chunkBuffer?.destroy();
            this.chunkBuffer = new StorageBuffer(this.device, this.chunkData.byteLength, BUFFERUSAGE_COPY_DST);
        }
        const data = this.chunkData;
        let k = 0;
        set.nodes.forEach((node, nodeIndex) => {
            const base = this.source.chunkBase(node);
            for (let offset = 0; offset < node.count; offset += CHUNK_SIZE) {
                data[k++] = base + offset;
                data[k++] = Math.min(CHUNK_SIZE, node.count - offset);
                data[k++] = nodeIndex;
                data[k++] = (node.lodIndex & 0xffff) | (node.fileIndex << 16);
            }
        });
        this.numChunks = count;
        // writeBuffer counts typed-array elements, not bytes
        if (count > 0)
            this.chunkBuffer.write(0, data, 0, count * 4);
        const words = Math.max(1, Math.ceil(set.nodes.length / 32));
        if (this.nodeVisibleData.length < words) {
            this.nodeVisibleData = new Uint32Array(words);
            this.nodeVisibleBuffer?.destroy();
            this.nodeVisibleBuffer = new StorageBuffer(this.device, words * 4, BUFFERUSAGE_COPY_DST);
        }
    }
    // the cache is dense (indexed by compact slot), so it only needs room for the resident
    // splats, not the allocator's address space; grown geometrically, never shrunk
    ensureCache(splats) {
        if (splats <= this.cacheSlots)
            return;
        this.cacheBuffer?.destroy();
        this.orderedBuffer?.destroy();
        this.cacheSlots = Math.max(1, Math.ceil(splats * 1.25));
        this.cacheBuffer = new StorageBuffer(this.device, this.cacheSlots * CACHE_WORDS * 4, BUFFERUSAGE_COPY_SRC);
        this.orderedBuffer = new StorageBuffer(this.device, this.cacheSlots * 4);
    }
    // sphere-frustum test per node on the cpu: thousands of nodes, one bit each
    cullNodes(set, viewProjection) {
        const bits = this.nodeVisibleData;
        bits.fill(0);
        this.frustum.setFromMat4(viewProjection);
        const spheres = set.nodeSpheres;
        const { sphere } = this;
        for (let i = 0; i < set.nodes.length; i++) {
            sphere.center.set(spheres[i * 4], spheres[i * 4 + 1], spheres[i * 4 + 2]);
            sphere.radius = spheres[i * 4 + 3];
            if (this.frustum.containsSphere(sphere) !== 0) {
                bits[i >> 5] |= 1 << (i & 31);
            }
        }
        const words = Math.max(1, Math.ceil(set.nodes.length / 32));
        this.nodeVisibleBuffer.write(0, bits, 0, words);
    }
    anyNodeVisible(nodes) {
        const bits = this.nodeVisibleData;
        return nodes.some((node) => (bits[node.nodeIndex >> 5] >>> (node.nodeIndex & 31)) & 1);
    }
    ensureProjector(occlusion, ordered, group) {
        const sourceKey = this.source.shaderKey();
        if (this.projectorSourceKey !== sourceKey) {
            // a different source: every specialisation and the bind group format go
            this.destroyProjector();
            this.projectorSourceKey = sourceKey;
        }
        const key = `${occlusion ? 'occlusion' : 'plain'}-${ordered ? 'bucket' : 'append'}`;
        const computeKey = `${key}:${group.fileIndex}`;
        const existing = this.projectorComputes.get(computeKey);
        if (existing)
            return existing;
        const shader = this.ensureProjectorShader(key, occlusion, ordered);
        const compute = new Compute(this.device, shader, 'sse-splat-project');
        this.projectorComputes.set(computeKey, compute);
        return compute;
    }
    // drop the computes of files that left the resident set
    pruneProjectorComputes(set) {
        for (const [key, compute] of this.projectorComputes) {
            const fileIndex = Number(key.slice(key.lastIndexOf(':') + 1));
            if (fileIndex >= 0 && !set.files[fileIndex]) {
                compute.destroy();
                this.projectorComputes.delete(key);
            }
        }
    }
    ensureProjectorShader(key, occlusion, ordered) {
        const existing = this.projectorShaders.get(key);
        if (existing)
            return existing;
        const { device } = this;
        const fixed = [
            new BindStorageBufferFormat('chunks', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('nodeVisible', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('occL1', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('occL2', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE)
        ];
        const formats = [...fixed, ...this.source.bindFormats()];
        this.projectorBindGroupFormat ??= new BindGroupFormat(device, formats);
        const shader = new Shader(device, {
            name: `sse-splat-project-${key}`,
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: projectorWGSL(this.source.readChunk(fixed.length), occlusion, ordered),
            cincludes: this.source.shaderIncludes(),
            cdefines: this.source.shaderDefines(),
            computeUniformBufferFormats: {
                // the same order as the wgsl struct; both follow the same alignment rules
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('view', UNIFORMTYPE_MAT4),
                    new UniformFormat('viewProj', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevViewProj', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevView', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevClipZ', UNIFORMTYPE_VEC4),
                    new UniformFormat('viewport', UNIFORMTYPE_VEC2),
                    new UniformFormat('focal', UNIFORMTYPE_VEC2),
                    new UniformFormat('prevViewport', UNIFORMTYPE_VEC2),
                    new UniformFormat('prevFocal', UNIFORMTYPE_VEC2),
                    new UniformFormat('numChunks', UNIFORMTYPE_UINT),
                    new UniformFormat('splatTextureSize', UNIFORMTYPE_UINT),
                    new UniformFormat('isOrtho', UNIFORMTYPE_UINT),
                    new UniformFormat('minPixelSize', UNIFORMTYPE_FLOAT),
                    new UniformFormat('alphaClip', UNIFORMTYPE_FLOAT),
                    new UniformFormat('minContribution', UNIFORMTYPE_FLOAT),
                    new UniformFormat('occBlocksX1', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksY1', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksX2', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksY2', UNIFORMTYPE_UINT),
                    new UniformFormat('occlusionMode', UNIFORMTYPE_UINT),
                    new UniformFormat('prevFlip', UNIFORMTYPE_FLOAT),
                    new UniformFormat('keyLogNear', UNIFORMTYPE_FLOAT),
                    new UniformFormat('keyInvLogRange', UNIFORMTYPE_FLOAT),
                    new UniformFormat('chunkBase', UNIFORMTYPE_UINT),
                    new UniformFormat('model', UNIFORMTYPE_MAT4),
                    new UniformFormat('modelRotation', UNIFORMTYPE_VEC4),
                    new UniformFormat('modelScale', UNIFORMTYPE_VEC4),
                    new UniformFormat('cameraPosition', UNIFORMTYPE_VEC4),
                    new UniformFormat('colorMax', UNIFORMTYPE_FLOAT),
                    new UniformFormat('unitScale', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthNear', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthFar', UNIFORMTYPE_FLOAT)
                ])
            },
            computeBindGroupFormat: this.projectorBindGroupFormat
        });
        this.projectorShaders.set(key, shader);
        return shader;
    }
    destroyProjector() {
        for (const compute of this.projectorComputes.values())
            compute.destroy();
        this.projectorComputes.clear();
        for (const shader of this.projectorShaders.values())
            shader.destroy();
        this.projectorShaders.clear();
        this.projectorBindGroupFormat?.destroy();
        this.projectorBindGroupFormat = null;
        this.projectorSourceKey = '';
    }
    destroy() {
        this.unsubscribe();
        this.app.off('frameend', this.onFrameEnd);
        this.detach();
        this.provider.destroy();
        this.source.destroy();
        this.destroyProjector();
        this.args.shader.destroy();
        this.args.destroy();
        this.argsBindGroupFormat.destroy();
        for (const compute of [this.reduceL1, this.reduceL2]) {
            compute.shader.destroy();
            compute.destroy();
        }
        for (const format of this.reduceFormats)
            format.destroy();
        this.occL1.destroy();
        this.occL2.destroy();
        for (const compute of [this.orderScan, this.orderScatter]) {
            compute.shader.destroy();
            compute.destroy();
        }
        for (const format of this.orderFormats)
            format.destroy();
        this.orderBuckets.destroy();
        this.orderedBuffer?.destroy();
        this.orderedBuffer = null;
        this.chunkBuffer?.destroy();
        this.nodeVisibleBuffer?.destroy();
        this.cacheBuffer?.destroy();
        this.counter.destroy();
        this.chunkBuffer = this.nodeVisibleBuffer = this.cacheBuffer = null;
        this.rasterPass.destroy();
        this.rasterInstance.destroy();
        this.rasterMaterial.destroy();
        this.rasterMesh.destroy();
        this.taaPass.destroy();
        this.taaInstance.destroy();
        this.taaMaterial.destroy();
        this.taaMesh.destroy();
        for (const target of this.taaTargets)
            target.destroy();
        for (const texture of [...this.taaColor, ...this.taaInfo])
            texture.destroy();
        this.taaTargets.length = 0;
        this.taaColor.length = 0;
        this.taaInfo.length = 0;
        this.target.destroy();
        this.colorTexture.destroy();
        this.depthTexture.destroy();
        this.composeInstance.destroy();
        this.composeMaterial.destroy();
        this.composeMesh.destroy();
    }
}

// ---------------------------------------------------------------------------
// WGSL compute shader: ray-march through the sparse voxel octree per pixel
// ---------------------------------------------------------------------------
const voxelOverlayWGSL = /* wgsl */ `

// Solid leaf sentinel: childMask=0xFF, baseOffset=0
const SOLID_LEAF_MARKER: u32 = 0xFF000000u;

// Maximum DDA steps to prevent infinite loops
const MAX_STEPS: u32 = 512u;

// Target wireframe edge width in pixels
const EDGE_PIXELS: f32 = 1.5;

// Keep edges tinted so dense grids retain the solid/free-space distinction.
const EDGE_ALPHA: f32 = 0.8;

const FILL_ALPHA: f32 = 0.4;

struct Uniforms {
    invVP: mat4x4<f32>,
    screenWidth: u32,
    screenHeight: u32,
    gridMinX: f32,
    gridMinY: f32,
    gridMinZ: f32,
    voxelRes: f32,
    numVoxelsX: u32,
    numVoxelsY: u32,
    numVoxelsZ: u32,
    leafSize: u32,
    treeDepth: u32,
    projScaleY: f32,
    displayMode: u32,
    inverted: u32
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> nodes: array<u32>;
@group(0) @binding(2) var<storage, read> leafData: array<u32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

// ---- helpers ----

// Traverse the octree for block (bx, by, bz). Returns vec2u(result, skipLevel):
//   result: 0 = empty, 1 = solid, 2+ = mixed leaf (2 + leafDataIndex)
//   skipLevel: octree level for multi-block skipping (meaningful when result == 0 or 1)
fn queryBlock(bx: i32, by: i32, bz: i32) -> vec2u {
    let depth = uniforms.treeDepth;
    var nodeIndex: u32 = 0u;

    for (var level: u32 = depth - 1u; ; ) {
        let node = nodes[nodeIndex];

        // Solid leaf sentinel -- return level + 1 so the caller can skip 2^(level+1) blocks
        if (node == SOLID_LEAF_MARKER) {
            return vec2u(1u, level + 1u);
        }

        let childMask = (node >> 24u) & 0xFFu;

        // childMask == 0 means this is a mixed leaf node
        if (childMask == 0u) {
            let leafIdx = node & 0x00FFFFFFu;
            return vec2u(2u + leafIdx, 0u);
        }

        // Determine octant at this level
        let bitX = (u32(bx) >> level) & 1u;
        let bitY = (u32(by) >> level) & 1u;
        let bitZ = (u32(bz) >> level) & 1u;
        let octant = (bitZ << 2u) | (bitY << 1u) | bitX;

        // Check if child exists
        if ((childMask & (1u << octant)) == 0u) {
            return vec2u(0u, level);
        }

        // Compute child index
        let baseOffset = node & 0x00FFFFFFu;
        let prefix = (1u << octant) - 1u;
        let childOffset = countOneBits(childMask & prefix);
        nodeIndex = baseOffset + childOffset;

        if (level == 0u) { break; }
        level -= 1u;
    }

    // Reached leaf level
    let node = nodes[nodeIndex];
    if (node == SOLID_LEAF_MARKER) {
        return vec2u(1u, 0u);
    }
    let leafIdx = node & 0x00FFFFFFu;
    return vec2u(2u + leafIdx, 0u);
}

// Ray-AABB intersection returning (tNear, tFar). If tNear > tFar → miss.
fn intersectAABB(ro: vec3f, invDir: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
    let t1 = (bmin - ro) * invDir;
    let t2 = (bmax - ro) * invDir;
    let tmin = min(t1, t2);
    let tmax = max(t1, t2);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar  = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(tNear, tFar);
}

// Compute wireframe edge factor (0 = interior, 1 = on edge) for a hit point on a voxel cube.
// Uses the median of the three per-axis face distances so it works on ANY face.
fn edgeFactor(hitPos: vec3f, voxMin: vec3f, voxSize: f32, edgeWidth: f32) -> f32 {
    let local = (hitPos - voxMin) / voxSize;

    // Distance to nearest face boundary for each axis
    let fx = min(local.x, 1.0 - local.x);
    let fy = min(local.y, 1.0 - local.y);
    let fz = min(local.z, 1.0 - local.z);

    // Median of three values = second smallest = edge distance.
    // On a face, one of fx/fy/fz is ~0 (the face normal axis).
    // The median gives the smaller of the other two = distance to nearest edge.
    let edgeDist = max(min(fx, fy), min(max(fx, fy), fz));

    return 1.0 - smoothstep(0.0, edgeWidth, edgeDist);
}

// Shade by the camera's occupancy: gray in free space, orange inside solid
// voxels (where the ray-march is inverted to find the exit into free space).
// Face-axis brightness and darker edges keep the grid shape readable.
fn shadeVoxelHit(hitPos: vec3f, voxMin: vec3f, voxelRes: f32, ro: vec3f) -> vec4f {
    let dist = length(hitPos - ro);
    let pixelWorld = 2.0 * dist / (f32(uniforms.screenHeight) * uniforms.projScaleY);
    let ew = clamp(EDGE_PIXELS * pixelWorld / voxelRes, 0.01, 0.5);

    let ef = edgeFactor(hitPos, voxMin, voxelRes, ew);

    let local = (hitPos - voxMin) / voxelRes;
    let fx = min(local.x, 1.0 - local.x);
    let fy = min(local.y, 1.0 - local.y);
    let fz = min(local.z, 1.0 - local.z);

    var faceAxis: u32 = 0u;
    if (fy <= fx && fy <= fz) {
        faceAxis = 1u;
    } else if (fz <= fx) {
        faceAxis = 2u;
    }

    var brightness = 0.85;
    if (faceAxis == 1u) { brightness = 0.65; }
    else if (faceAxis == 2u) { brightness = 0.45; }

    let tint = select(vec3f(1.0), vec3f(1.0, 0.35, 0.08), uniforms.inverted != 0u);
    let color = tint * mix(brightness, 0.2, ef);
    let alpha = mix(FILL_ALPHA, EDGE_ALPHA, ef);

    return vec4f(color * alpha, alpha);
}

// Blue (0) -> Cyan (0.25) -> Green (0.5) -> Yellow (0.75) -> Red (1.0)
fn heatmap(t: f32) -> vec3f {
    let c = clamp(t, 0.0, 1.0);
    let r = clamp(min(c - 0.5, 1.0) * 2.0, 0.0, 1.0);
    let g = select(clamp(c * 4.0, 0.0, 1.0), clamp((1.0 - c) * 4.0, 0.0, 1.0), c > 0.5);
    let b = clamp(1.0 - c * 2.0, 0.0, 1.0);
    return vec3f(r, g, b);
}

// ---- main ----

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let px = i32(gid.x);
    let py = i32(gid.y);
    let sw = i32(uniforms.screenWidth);
    let sh = i32(uniforms.screenHeight);

    if (px >= sw || py >= sh) {
        return;
    }

    // Reconstruct world-space ray from pixel coordinates
    let ndcX = (f32(px) + 0.5) / f32(sw) * 2.0 - 1.0;
    let ndcY = -((f32(py) + 0.5) / f32(sh) * 2.0 - 1.0);

    let clipNear = vec4f(ndcX, ndcY, 0.0, 1.0);
    let clipFar  = vec4f(ndcX, ndcY, 1.0, 1.0);

    var worldNear = uniforms.invVP * clipNear;
    worldNear = worldNear / worldNear.w;
    var worldFar = uniforms.invVP * clipFar;
    worldFar = worldFar / worldFar.w;

    let ro = worldNear.xyz;
    let rd = normalize(worldFar.xyz - worldNear.xyz);

    // Grid AABB
    let gridMin = vec3f(uniforms.gridMinX, uniforms.gridMinY, uniforms.gridMinZ);
    let gridMax = gridMin + vec3f(
        f32(uniforms.numVoxelsX),
        f32(uniforms.numVoxelsY),
        f32(uniforms.numVoxelsZ)
    ) * uniforms.voxelRes;

    let invDir = 1.0 / rd;
    let gridHit = intersectAABB(ro, invDir, gridMin, gridMax);

    if (max(gridHit.x, 0.0) > gridHit.y) {
        textureStore(outputTexture, vec2i(px, py), vec4f(0.0));
        return;
    }

    let tEntry = max(gridHit.x, 0.0) + 0.0001;

    // Entry point in voxel-index space
    let entryWorld = ro + rd * tEntry;
    let voxelRes = uniforms.voxelRes;
    let lsf = f32(uniforms.leafSize);
    let blockRes = voxelRes * lsf;
    let leafSz = i32(uniforms.leafSize);

    // Block-level DDA setup
    let entryBlock = (entryWorld - gridMin) / blockRes;
    let numBlocksX = i32(uniforms.numVoxelsX / uniforms.leafSize);
    let numBlocksY = i32(uniforms.numVoxelsY / uniforms.leafSize);
    let numBlocksZ = i32(uniforms.numVoxelsZ / uniforms.leafSize);

    var bx = clamp(i32(floor(entryBlock.x)), 0, numBlocksX - 1);
    var by = clamp(i32(floor(entryBlock.y)), 0, numBlocksY - 1);
    var bz = clamp(i32(floor(entryBlock.z)), 0, numBlocksZ - 1);

    let stepX = select(-1, 1, rd.x >= 0.0);
    let stepY = select(-1, 1, rd.y >= 0.0);
    let stepZ = select(-1, 1, rd.z >= 0.0);

    let tDeltaX = abs(blockRes / rd.x);
    let tDeltaY = abs(blockRes / rd.y);
    let tDeltaZ = abs(blockRes / rd.z);

    // tMax: t value to reach next block boundary along each axis
    let blockMinWorld = gridMin + vec3f(f32(bx), f32(by), f32(bz)) * blockRes;
    let nextBoundX = select(blockMinWorld.x, blockMinWorld.x + blockRes, rd.x >= 0.0);
    let nextBoundY = select(blockMinWorld.y, blockMinWorld.y + blockRes, rd.y >= 0.0);
    let nextBoundZ = select(blockMinWorld.z, blockMinWorld.z + blockRes, rd.z >= 0.0);

    var tMaxX = (nextBoundX - ro.x) / rd.x;
    var tMaxY = (nextBoundY - ro.y) / rd.y;
    var tMaxZ = (nextBoundZ - ro.z) / rd.z;

    let inv = uniforms.inverted != 0u;
    var totalWork: u32 = 0u;

    for (var step: u32 = 0u; step < MAX_STEPS; step++) {
        totalWork += 1u;

        let qResult = queryBlock(bx, by, bz);
        let blockResult = qResult.x;
        let skipLevel = qResult.y;

        // Normal: skip large empty regions.  Inverted: skip large solid regions.
        let shouldSkip = select(
            blockResult == 0u && skipLevel >= 1u,
            blockResult == 1u && skipLevel >= 1u,
            inv
        );

        if (shouldSkip) {
            let cellBlocks = i32(1u << skipLevel);
            let cellMask = ~(cellBlocks - 1);
            let cellXMin = bx & cellMask;
            let cellYMin = by & cellMask;
            let cellZMin = bz & cellMask;

            for (var skip: u32 = 0u; skip < 128u; skip++) {
                totalWork += 1u;

                if (tMaxX < tMaxY && tMaxX < tMaxZ) {
                    bx += stepX;
                    tMaxX += tDeltaX;
                    if (bx < cellXMin || bx >= cellXMin + cellBlocks) { break; }
                } else if (tMaxY < tMaxZ) {
                    by += stepY;
                    tMaxY += tDeltaY;
                    if (by < cellYMin || by >= cellYMin + cellBlocks) { break; }
                } else {
                    bz += stepZ;
                    tMaxZ += tDeltaZ;
                    if (bz < cellZMin || bz >= cellZMin + cellBlocks) { break; }
                }
            }
        } else {
            // Normal: enter voxel DDA for non-empty blocks.
            // Inverted: enter voxel DDA for non-solid blocks (empty or mixed).
            let enterDDA = select(blockResult != 0u, blockResult != 1u, inv);

            if (enterDDA) {
                let blockOrigin = gridMin + vec3f(f32(bx), f32(by), f32(bz)) * blockRes;

                let blockMax = blockOrigin + vec3f(blockRes);
                let bHit = intersectAABB(ro, invDir, blockOrigin, blockMax);
                let tBlockEntry = max(bHit.x, 0.0);

                // Voxel-level DDA within the block
                let entryVoxWorld = ro + rd * (tBlockEntry + 0.0001);
                let entryLocal = (entryVoxWorld - blockOrigin) / voxelRes;
                var vx = clamp(i32(floor(entryLocal.x)), 0, leafSz - 1);
                var vy = clamp(i32(floor(entryLocal.y)), 0, leafSz - 1);
                var vz = clamp(i32(floor(entryLocal.z)), 0, leafSz - 1);

                let vTDeltaX = abs(voxelRes / rd.x);
                let vTDeltaY = abs(voxelRes / rd.y);
                let vTDeltaZ = abs(voxelRes / rd.z);

                let voxOrigin = blockOrigin + vec3f(f32(vx), f32(vy), f32(vz)) * voxelRes;
                let vNextX = select(voxOrigin.x, voxOrigin.x + voxelRes, rd.x >= 0.0);
                let vNextY = select(voxOrigin.y, voxOrigin.y + voxelRes, rd.y >= 0.0);
                let vNextZ = select(voxOrigin.z, voxOrigin.z + voxelRes, rd.z >= 0.0);

                var vTMaxX = (vNextX - ro.x) / rd.x;
                var vTMaxY = (vNextY - ro.y) / rd.y;
                var vTMaxZ = (vNextZ - ro.z) / rd.z;

                var maskLo: u32 = 0u;
                var maskHi: u32 = 0u;
                if (blockResult > 1u) {
                    let leafIdx = blockResult - 2u;
                    maskLo = leafData[leafIdx * 2u];
                    maskHi = leafData[leafIdx * 2u + 1u];
                }

                for (var vStep: u32 = 0u; vStep < 12u; vStep++) {
                    totalWork += 1u;

                    var isSolid = false;

                    if (blockResult == 1u) {
                        isSolid = true;
                    } else {
                        let bitIndex = u32(vz) * 16u + u32(vy) * 4u + u32(vx);
                        isSolid = select(
                            (maskHi & (1u << (bitIndex - 32u))) != 0u,
                            (maskLo & (1u << bitIndex)) != 0u,
                            bitIndex < 32u
                        );
                    }

                    let isHit = select(isSolid, !isSolid, inv);

                    if (isHit) {
                        if (uniforms.displayMode == 0u) {
                            let voxMin = blockOrigin + vec3f(f32(vx), f32(vy), f32(vz)) * voxelRes;
                            let vHit = intersectAABB(ro, invDir, voxMin, voxMin + vec3f(voxelRes));
                            let hitPos = ro + rd * max(vHit.x, 0.0);
                            let result = shadeVoxelHit(hitPos, voxMin, voxelRes, ro);
                            textureStore(outputTexture, vec2i(px, py), result);
                        } else {
                            let effort = f32(totalWork) / 256.0;
                            let color = heatmap(effort);
                            textureStore(outputTexture, vec2i(px, py), vec4f(color, 1.0));
                        }
                        return;
                    }

                    // Advance voxel DDA
                    if (vTMaxX < vTMaxY && vTMaxX < vTMaxZ) {
                        vx += stepX;
                        vTMaxX += vTDeltaX;
                        if (vx < 0 || vx >= leafSz) { break; }
                    } else if (vTMaxY < vTMaxZ) {
                        vy += stepY;
                        vTMaxY += vTDeltaY;
                        if (vy < 0 || vy >= leafSz) { break; }
                    } else {
                        vz += stepZ;
                        vTMaxZ += vTDeltaZ;
                        if (vz < 0 || vz >= leafSz) { break; }
                    }
                }
            }

            // Advance block DDA
            if (tMaxX < tMaxY && tMaxX < tMaxZ) {
                bx += stepX;
                tMaxX += tDeltaX;
            } else if (tMaxY < tMaxZ) {
                by += stepY;
                tMaxY += tDeltaY;
            } else {
                bz += stepZ;
                tMaxZ += tDeltaZ;
            }
        }

        if (bx < 0 || by < 0 || bz < 0 ||
            bx >= numBlocksX || by >= numBlocksY || bz >= numBlocksZ) {
            break;
        }
    }

    textureStore(outputTexture, vec2i(px, py), vec4f(0.0));
}
`;
// ---------------------------------------------------------------------------
// VoxelDebugOverlay class
// ---------------------------------------------------------------------------
class VoxelDebugOverlay {
    app;
    camera;
    compute;
    storageTexture;
    overlayMaterial;
    quad;
    nodesBuffer;
    leafDataBuffer;
    collision;
    currentWidth = 0;
    currentHeight = 0;
    invVP = new Mat4();
    vpTemp = new Mat4();
    /** Whether the overlay is currently rendering. */
    enabled = false;
    /** Display mode: 'overlay' for wireframe debug, 'heatmap' for effort visualization. */
    mode = 'overlay';
    constructor(app, collision, camera) {
        this.app = app;
        this.camera = camera;
        this.collision = collision;
        const device = app.graphicsDevice;
        // Upload SVO node array as a read-only storage buffer
        const nodesData = collision.nodes;
        const nodesByteSize = Math.max(nodesData.byteLength, 4);
        this.nodesBuffer = new StorageBuffer(device, nodesByteSize, BUFFERUSAGE_COPY_DST);
        if (nodesData.byteLength > 0) {
            this.nodesBuffer.write(0, nodesData, 0, nodesData.length);
        }
        // Upload leaf data as a read-only storage buffer
        const leafDataArr = collision.leafData;
        const leafByteSize = Math.max(leafDataArr.byteLength, 4);
        this.leafDataBuffer = new StorageBuffer(device, leafByteSize, BUFFERUSAGE_COPY_DST);
        if (leafDataArr.byteLength > 0) {
            this.leafDataBuffer.write(0, leafDataArr, 0, leafDataArr.length);
        }
        // Create the initial storage texture (will be resized on first update)
        this.currentWidth = Math.max(device.width, 1);
        this.currentHeight = Math.max(device.height, 1);
        this.storageTexture = this.createStorageTexture(this.currentWidth, this.currentHeight);
        // Create compute shader
        const shaderDefinition = {
            name: 'VoxelDebugOverlay',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: voxelOverlayWGSL,
            computeUniformBufferFormats: {
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('invVP', UNIFORMTYPE_MAT4),
                    new UniformFormat('screenWidth', UNIFORMTYPE_UINT),
                    new UniformFormat('screenHeight', UNIFORMTYPE_UINT),
                    new UniformFormat('gridMinX', UNIFORMTYPE_FLOAT),
                    new UniformFormat('gridMinY', UNIFORMTYPE_FLOAT),
                    new UniformFormat('gridMinZ', UNIFORMTYPE_FLOAT),
                    new UniformFormat('voxelRes', UNIFORMTYPE_FLOAT),
                    new UniformFormat('numVoxelsX', UNIFORMTYPE_UINT),
                    new UniformFormat('numVoxelsY', UNIFORMTYPE_UINT),
                    new UniformFormat('numVoxelsZ', UNIFORMTYPE_UINT),
                    new UniformFormat('leafSize', UNIFORMTYPE_UINT),
                    new UniformFormat('treeDepth', UNIFORMTYPE_UINT),
                    new UniformFormat('projScaleY', UNIFORMTYPE_FLOAT),
                    new UniformFormat('displayMode', UNIFORMTYPE_UINT),
                    new UniformFormat('inverted', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: new BindGroupFormat(device, [
                new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
                new BindStorageBufferFormat('nodes', SHADERSTAGE_COMPUTE, true),
                new BindStorageBufferFormat('leafData', SHADERSTAGE_COMPUTE, true),
                new BindStorageTextureFormat('outputTexture', PIXELFORMAT_RGBA8, TEXTUREDIMENSION_2D)
            ])
        };
        const shader = new Shader(device, shaderDefinition);
        // Create compute instance
        this.compute = new Compute(device, shader, 'VoxelDebugOverlay');
        // Create overlay material with premultiplied alpha blending and a custom
        // fragment shader that preserves the texture's alpha channel (the built-in
        // getTextureShaderDesc hardcodes alpha = 1.0, which prevents blending).
        this.overlayMaterial = new ShaderMaterial();
        this.overlayMaterial.cull = CULLFACE_NONE;
        this.overlayMaterial.blendType = BLEND_PREMULTIPLIED;
        this.overlayMaterial.depthTest = false;
        this.overlayMaterial.depthWrite = false;
        this.overlayMaterial.setParameter('colorMap', this.storageTexture);
        this.overlayMaterial.shaderDesc = {
            uniqueName: 'VoxelOverlayComposite',
            vertexGLSL: /* glsl */ `
                attribute vec2 vertex_position;
                uniform mat4 matrix_model;
                varying vec2 uv0;
                void main(void) {
                    gl_Position = matrix_model * vec4(vertex_position, 0, 1);
                    uv0 = vertex_position.xy + 0.5;
                }
            `,
            vertexWGSL: /* wgsl */ `
                attribute vertex_position: vec2f;
                uniform matrix_model: mat4x4f;
                varying uv0: vec2f;
                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
                    output.uv0 = input.vertex_position.xy + vec2f(0.5);
                    return output;
                }
            `,
            fragmentGLSL: /* glsl */ `
                varying vec2 uv0;
                uniform sampler2D colorMap;
                void main(void) {
                    gl_FragColor = texture2D(colorMap, uv0);
                }
            `,
            fragmentWGSL: /* wgsl */ `
                varying uv0: vec2f;
                var colorMap: texture_2d<f32>;
                var colorMapSampler: sampler;
                @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    output.color = textureSample(colorMap, colorMapSampler, input.uv0);
                    return output;
                }
            `,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
        this.overlayMaterial.update();
        // Fullscreen quad in the default draw layer, shown on frames update() composites.
        // The node is outside the hierarchy, so its fixed transform is synced here once.
        const mesh = new Mesh(device);
        mesh.setPositions([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]);
        mesh.update(PRIMITIVE_TRISTRIP);
        const node = new GraphNode('VoxelOverlayComposite');
        node.setLocalScale(2, -2, 1);
        node.getWorldTransform();
        this.quad = new MeshInstance(mesh, this.overlayMaterial, node);
        this.quad.cull = false;
        this.quad.castShadow = false;
        this.quad.pick = false;
        this.quad.visible = false;
        app.scene.defaultDrawLayer.addMeshInstances([this.quad], true);
    }
    createStorageTexture(width, height) {
        return new Texture(this.app.graphicsDevice, {
            name: 'VoxelOverlay-Storage',
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            addressU: 3, // ADDRESS_CLAMP_TO_EDGE
            addressV: 3, // ADDRESS_CLAMP_TO_EDGE
            storage: true
        });
    }
    update() {
        this.quad.visible = false;
        if (!this.enabled || this.collision.nodes.length === 0)
            return;
        const { app, camera, compute, collision } = this;
        const device = app.graphicsDevice;
        const width = device.width;
        const height = device.height;
        if (width <= 0 || height <= 0)
            return;
        // Resize storage texture if screen dimensions changed
        if (width !== this.currentWidth || height !== this.currentHeight) {
            this.storageTexture.destroy();
            this.currentWidth = width;
            this.currentHeight = height;
            this.storageTexture = this.createStorageTexture(width, height);
            // Update the overlay material to reference the new texture
            this.overlayMaterial.setParameter('colorMap', this.storageTexture);
            this.overlayMaterial.update();
        }
        // Compute inverse view-projection matrix
        const cam = camera.camera;
        this.vpTemp.mul2(cam.projectionMatrix, cam.viewMatrix);
        this.invVP.copy(this.vpTemp).invert();
        // For legacy v1.0 data, pre-multiply invVP by R_z180 (negate X/Y rows)
        // to transform rays from PlayCanvas world space into the raw voxel space
        if (collision.flipXY) {
            const d = this.invVP.data;
            d[0] = -d[0];
            d[1] = -d[1];
            d[4] = -d[4];
            d[5] = -d[5];
            d[8] = -d[8];
            d[9] = -d[9];
            d[12] = -d[12];
            d[13] = -d[13];
        }
        // Set compute uniforms
        compute.setParameter('invVP', this.invVP.data);
        compute.setParameter('screenWidth', width);
        compute.setParameter('screenHeight', height);
        compute.setParameter('gridMinX', collision.gridMinX);
        compute.setParameter('gridMinY', collision.gridMinY);
        compute.setParameter('gridMinZ', collision.gridMinZ);
        compute.setParameter('voxelRes', collision.voxelResolution);
        compute.setParameter('numVoxelsX', collision.numVoxelsX);
        compute.setParameter('numVoxelsY', collision.numVoxelsY);
        compute.setParameter('numVoxelsZ', collision.numVoxelsZ);
        compute.setParameter('leafSize', collision.leafSize);
        compute.setParameter('treeDepth', collision.treeDepth);
        compute.setParameter('projScaleY', cam.projectionMatrix.data[5]);
        compute.setParameter('displayMode', this.mode === 'heatmap' ? 1 : 0);
        const camPos = camera.getPosition();
        let wx = camPos.x, wy = camPos.y;
        const wz = camPos.z;
        if (collision.flipXY) {
            wx = -wx;
            wy = -wy;
        }
        const ix = Math.floor((wx - collision.gridMinX) / collision.voxelResolution);
        const iy = Math.floor((wy - collision.gridMinY) / collision.voxelResolution);
        const iz = Math.floor((wz - collision.gridMinZ) / collision.voxelResolution);
        compute.setParameter('inverted', collision.isVoxelSolid(ix, iy, iz) ? 1 : 0);
        // Set storage buffers and output texture
        compute.setParameter('nodes', this.nodesBuffer);
        compute.setParameter('leafData', this.leafDataBuffer);
        compute.setParameter('outputTexture', this.storageTexture);
        // Dispatch compute shader
        const workgroupsX = Math.ceil(width / 8);
        const workgroupsY = Math.ceil(height / 8);
        compute.setupDispatch(workgroupsX, workgroupsY, 1);
        device.computeDispatch([compute], 'VoxelDebugOverlay');
        // Composite overlay on top of the scene
        this.quad.visible = true;
    }
    destroy() {
        this.app.scene.defaultDrawLayer.removeMeshInstances([this.quad], true);
        this.quad.destroy();
        this.compute.destroy();
        this.compute.shader.destroy();
        this.overlayMaterial.destroy();
        this.nodesBuffer?.destroy();
        this.leafDataBuffer?.destroy();
        this.storageTexture?.destroy();
    }
}

// Standalone headsets run XR on a mobile gpu, which draws every splat once per eye, but their
// browsers report a desktop platform. Their sessions render with fixed foveation and a 72 Hz
// target, at 0.8x resolution in performance mode, and the viewer lowers the splat budget.
const standaloneHeadset = /OculusBrowser|PicoBrowser/.test(globalThis.navigator?.userAgent ?? '');
// The viewer reconfigures the camera (clear color, post effects) when state.xrMode changes
const initXr = (global) => {
    const { app, events, state, camera, renderer, root } = global;
    const { xr } = app;
    let destroyed = false;
    let restoreFrame = null;
    let rejectStart = null;
    let rejectEnd = null;
    const gone = () => new Error('the viewer has been destroyed');
    // Engine availability is backend-aware (2.20+): under WebGPU a session is only
    // reported available when it can start on the current device (browser exposes
    // XRGPUBinding, e.g. Safari on Apple Vision Pro). A session the WebGPU device
    // can't host may still run after reloading into WebGL, so keep the buttons
    // visible then — the UI offers that reload when the session can't start directly.
    let webglAR = false;
    let webglVR = false;
    const updateAvailable = () => {
        if (destroyed)
            return;
        state.canStartAR = xr.isAvailable('immersive-ar');
        state.canStartVR = xr.isAvailable('immersive-vr');
        state.hasAR = state.canStartAR || webglAR;
        state.hasVR = state.canStartVR || webglVR;
    };
    updateAvailable();
    const availability = xr.on('available', updateAvailable);
    if (renderer === 'webgpu') {
        Promise.all([
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-ar'),
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-vr')
        ]).then(([ar, vr]) => {
            if (destroyed)
                return;
            webglAR = ar;
            webglVR = vr;
            updateAvailable();
        });
    }
    const parent = camera.parent;
    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    parent.addComponent('script');
    parent.script.create(XrControllers);
    parent.script.create(XrNavigation);
    // Grabbing with both hands drags, turns and scales the scene. Created once the splat entity
    // it moves has loaded, which is before XR can start, and put back when the session ends, as
    // the viewer's camera, collision and annotations assume the authored placement.
    let manipulation = null;
    const started = xr.on('start', () => {
        if (destroyed)
            return;
        app.autoRender = true;
        // cache original camera rig positions and rotations
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());
        // Start the session where the camera is, facing its heading with pitch and roll reset:
        // where it looks across the ground, or where the top of its view points when it looks
        // straight up or down. The yaw of getEulerAngles() only covers -90 to 90 degrees, so a
        // camera facing further round would start the session facing the wrong way.
        const { forward } = camera;
        let x = forward.x;
        let z = forward.z;
        if (x * x + z * z < 1e-6) {
            const { up } = camera;
            const sign = forward.y < 0 ? 1 : -1;
            x = up.x * sign;
            z = up.z * sign;
        }
        parent.setPosition(cameraPosition.x, 0, cameraPosition.z);
        parent.setEulerAngles(0, Math.atan2(-x, -z) * math.RAD_TO_DEG, 0);
        if (standaloneHeadset) {
            xr.fixedFoveation = 1;
            if (xr.supportedFrameRates?.includes(72))
                xr.updateTargetFrameRate(72);
        }
        // AR scales about the hands, for content brought to a tabletop; VR about the feet, so
        // the user stays standing on the scene
        if (manipulation)
            manipulation.scalePivot = xr.type === 'immersive-ar' ? 'hands' : 'feet';
        state.xrMode = xr.type === 'immersive-ar' ? 'ar' : 'vr';
    });
    const ended = xr.on('end', () => {
        if (destroyed)
            return;
        app.autoRender = false;
        // restore camera to pre-XR state
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);
        manipulation?.reset();
        state.xrMode = null;
        // Restore the canvas to the correct position in the DOM after exiting XR. In
        // some browsers (e.g. Chrome on Android) the canvas is moved to a new root
        // during XR, and needs to be moved back on exit.
        if (restoreFrame !== null)
            cancelAnimationFrame(restoreFrame);
        restoreFrame = requestAnimationFrame(() => {
            restoreFrame = null;
            if (destroyed)
                return;
            root.prepend(app.graphicsDevice.canvas);
            app.renderNextFrame = true;
        });
    });
    const start = async (mode) => {
        if (destroyed)
            throw gone();
        if (mode !== 'ar' && mode !== 'vr')
            throw new Error('startXR: mode must be ar or vr');
        if (rejectStart || rejectEnd || xr.active)
            throw new Error('startXR: a session is active or pending');
        const type = mode === 'ar' ? 'immersive-ar' : 'immersive-vr';
        if (!xr.isAvailable(type)) {
            const offered = mode === 'ar' ? state.hasAR : state.hasVR;
            throw new Error(offered ? 'startXR: reload with WebGL to start this session' : 'startXR: XR is not available');
        }
        const { nearClip, farClip } = camera.camera;
        camera.camera.nearClip = 0.01;
        camera.camera.farClip = 1000;
        try {
            await new Promise((resolve, reject) => {
                rejectStart = reject;
                xr.start(camera.camera, type, 'local-floor', {
                    framebufferScaleFactor: standaloneHeadset && state.performanceMode ? 0.8 : 1,
                    callback: (error) => {
                        if (destroyed) {
                            // Browser session requests cannot be cancelled. Close a late result.
                            void xr.session?.end().catch(() => {
                                /* already ended */
                            });
                            reject(gone());
                        }
                        else if (error) {
                            reject(error);
                        }
                        else {
                            resolve();
                        }
                    }
                });
            });
            if (destroyed)
                throw gone();
        }
        catch (error) {
            if (!destroyed) {
                camera.camera.nearClip = nearClip;
                camera.camera.farClip = farClip;
            }
            throw error;
        }
        finally {
            rejectStart = null;
        }
    };
    const end = async () => {
        if (destroyed)
            throw gone();
        if (rejectStart)
            throw new Error('endXR: a session is still starting');
        if (rejectEnd)
            throw new Error('endXR: a session is already ending');
        const { session } = xr;
        if (!session)
            return;
        let onEnd;
        try {
            await new Promise((resolve, reject) => {
                rejectEnd = reject;
                onEnd = resolve;
                xr.once('end', onEnd);
                // Use the native promise too: XrManager.end's callback does not report a
                // rejected session.end() promise. The engine handles browser-initiated ends.
                session.end().catch(reject);
            });
            if (destroyed)
                throw gone();
        }
        finally {
            xr.off('end', onEnd);
            rejectEnd = null;
        }
    };
    const cancel = events.on('inputEvent', (event) => {
        if (event === 'cancel' && xr.active) {
            void end().catch(() => {
                /* the browser may already be ending the session */
            });
        }
    });
    return {
        start,
        end,
        setManipulationTarget: (entity) => {
            manipulation = parent.script.create(XrManipulation, {
                properties: { target: entity }
            });
        },
        destroy: () => {
            destroyed = true;
            availability.off();
            started.off();
            ended.off();
            cancel.off();
            if (restoreFrame !== null)
                cancelAnimationFrame(restoreFrame);
            rejectStart?.(gone());
            rejectEnd?.(gone());
            state.xrMode = null;
        }
    };
};

// String.replace wrapper that warns when the source substring is missing, so
// shader chunk patches against the engine fail loudly instead of silently
// producing the original chunk.
const patchChunk = (source, search, replacement, name) => {
    if (!source.includes(search)) {
        console.warn(`patchChunk: substring not found in '${name}', shader chunk patch may be out of sync with the engine.`);
    }
    return source.replace(search, replacement);
};
const gammaChunkGlsl = `
vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
    return gammaColor;
}
`;
const gammaChunkWgsl = `
fn prepareOutputFromGamma(gammaColor: vec3f, depth: f32) -> vec3f {
    return gammaColor;
}
`;
const rendererTable = {
    webgl: GSPLAT_RENDERER_RASTER_CPU_SORT,
    webgpu: GSPLAT_RENDERER_RASTER_GPU_SORT
};
// quality budget, millions of splats
const budgets = {
    mobile: {
        low: 1,
        high: 2
    },
    desktop: {
        low: 2,
        high: 4
    }
};
// budget while an XR session runs on a standalone headset, millions of splats. On a Quest 3,
// 1M splats render at about 30 fps (40 at 0.8x resolution), against 10 fps at the 4M desktop
// budget it otherwise gets
const standaloneXrBudget = 1;
// how much further away parts of the scene behind the camera count when choosing their detail,
// which saves a lot of splats while orbiting, and the turn after which detail is chosen again.
// XR sessions choose detail by distance alone, with no penalty and no turn-triggered choices: a
// head turning less than 90 degrees brought the coarse detail chosen for behind it into view
const lodBehindPenalty = 5;
const lodUpdateAngle = 90;
const tonemapTable = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};
const applyPostEffectSettings = (cameraFrame, settings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    }
    else {
        cameraFrame.rendering.sharpness = 0;
    }
    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    }
    else {
        bloom.intensity = 0;
    }
    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    }
    else {
        grading.enabled = false;
    }
    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    }
    else {
        vignette.intensity = 0;
    }
    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    }
    else {
        fringing.intensity = 0;
    }
};
const anyPostEffectEnabled = (settings) => {
    return ((settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        settings.grading.enabled ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0));
};
const vec = new Vec3();
// When post effects are on, the final compose blit must not convert linear to gamma, which
// the engine decides from `isColorBufferSrgb` on the target. The backbuffer is not ours to
// flag, so the prototype is patched — keyed by device rather than closed over one, so several
// viewers on a page (with and without post effects) each get the right answer. Restored when
// no device needs it.
const origIsColorBufferSrgb = RenderTarget.prototype.isColorBufferSrgb;
const srgbBackBufferDevices = new Set();
const patchedIsColorBufferSrgb = function (index) {
    return srgbBackBufferDevices.has(this.device) && this === this.device.backBuffer
        ? true
        : origIsColorBufferSrgb.call(this, index);
};
const setBackBufferSrgb = (device, enabled) => {
    if (enabled) {
        srgbBackBufferDevices.add(device);
    }
    else {
        srgbBackBufferDevices.delete(device);
    }
    RenderTarget.prototype.isColorBufferSrgb = srgbBackBufferDevices.size
        ? patchedIsColorBufferSrgb
        : origIsColorBufferSrgb;
};
class Viewer {
    global;
    cameraFrame;
    inputController;
    cameraManager;
    picker;
    voxelOverlay = null;
    meshOverlay = null;
    navCursor = null;
    debugPanel = null;
    /** The opt-in stochastic renderer (WebGPU only); null when the engine's sorted renderer draws. */
    splatRenderer = null;
    /**
     * The engine's MiniStats panel once first shown (`?ministats` or the debug panel), else null.
     * Hiding disables it rather than destroying it.
     */
    miniStats = null;
    /** Set once {@link destroy} has run. Load continuations check it and bail. */
    destroyed = false;
    disposers = [];
    fullscreen;
    xr;
    capture = null;
    // captures are serialised: they share the viewer camera, so concurrent ones would
    // interleave the redirect/restore and could leave it mis-targeted
    captureQueue = Promise.resolve();
    // Resolves once the first complete frame has rendered, and rejects if the viewer is
    // destroyed before that — the frame event it waits on is gone by then, so a capture
    // waiting here would never settle. One shared promise, so its waiters are released when it
    // settles either way.
    ready;
    failReady;
    // Abort signals for frame waits and captures in flight. A capture's later waits are inside the engine,
    // so they are raced against one of these rather than handled individually — and each is
    // removed as its capture settles, since a signal that outlived it would keep the race, and
    // with it the captured image, reachable until the viewer went away.
    abortHandlers = new Set();
    origChunks;
    constructor(global, gsplatLoad, skyboxLoad, collisionLoad) {
        this.global = global;
        const { app, settings, config, events, state, camera, renderer } = global;
        const { graphicsDevice } = app;
        this.fullscreen = initFullscreen(global);
        this.xr = initXr(global);
        this.ready = new Promise((resolve, reject) => {
            events.once('firstFrame', () => resolve());
            this.failReady = reject;
        });
        // destroying a viewer that never captured anything must not report an unhandled rejection
        this.ready.catch(() => {
            // intentionally ignored
        });
        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', patchChunk(glsl.get('skyboxPS'), 'mapRoughnessUv(uv, mipLevel)', 'uv', 'glsl skyboxPS'));
        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', patchChunk(wgsl.get('skyboxPS'), 'mapRoughnessUv(uv, uniform.mipLevel)', 'uv', 'wgsl skyboxPS'));
        this.origChunks = {
            glsl: {
                gsplatOutputVS: glsl.get('gsplatOutputVS'),
                skyboxPS: glsl.get('skyboxPS')
            },
            wgsl: {
                gsplatOutputVS: wgsl.get('gsplatOutputVS'),
                skyboxPS: wgsl.get('skyboxPS')
            }
        };
        // Render every frame while the scene loads, then switch to on-demand rendering once the
        // first complete frame is ready (autoRender is disabled in the frame:ready handler below).
        // Loading progress and the ready transition are both reported via frame:ready, which only
        // fires when a frame is rendered — so we must render continuously through loading. After
        // that, rendering is driven on demand by frame:request and camera-change detection. This
        // mirrors the engine's simple-on-demand gsplat example.
        app.autoRender = true;
        // configure the camera
        this.configureCamera(settings);
        // The stochastic renderer, when opted in. Created before the first frame so it can
        // switch the engine's own splat renderer off as soon as the engine creates it. An
        // instance without the flag never constructs it, and the sorted path is untouched.
        if (config.stochastic && renderer === 'webgpu') {
            const worldLayer = app.scene.layers.getLayerByName('World');
            // the largest budget this instance can ask for must fit the device's storage binding
            const budget = (config.budget && config.budget > 0
                ? config.budget
                : (platform.mobile ? budgets.mobile : budgets.desktop).high) * 1000000;
            if (!StochasticSplatRenderer.cacheFits(app.graphicsDevice, budget)) {
                console.warn(`stochastic renderer: a ${budget / 1000000}M splat budget exceeds this device's storage binding limit; the sorted renderer draws`);
            }
            else if (worldLayer) {
                this.splatRenderer = new StochasticSplatRenderer(app, camera.camera, worldLayer, {
                    source: config.splatSource,
                    variant: config.variant
                });
                // announced on the first frame rather than here: createViewer resolves after this
                // constructor, so a page can only subscribe once loading is under way
                events.once('firstFrame', () => events.fire('splatRenderer:ready', this.splatRenderer));
            }
        }
        // reconfigure camera when entering/exiting XR. The stochastic renderer has no stereo
        // path yet, so the engine's renderer draws the splats for the session. Follows xrMode
        // rather than app.xr.active, which still reports the session while its 'end' handlers run
        const xrModeChanged = events.on('xrMode:changed', () => {
            if (this.destroyed)
                return;
            this.configureCamera(settings);
            this.splatRenderer?.setEnabled(state.xrMode === null);
        });
        this.onDestroy(() => xrModeChanged.off());
        // debug ministats, from the flag at start and the debug panel's toggle after
        this.setMiniStats(config.ministats);
        this.onDestroy(() => {
            this.miniStats?.destroy();
            this.miniStats = null;
        });
        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();
        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;
            if (!app.renderNextFrame) {
                if (this.miniStats?.enabled ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }
            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });
        const applyCamera = (camera) => {
            const cameraEntity = global.camera;
            cameraEntity.setPosition(camera.position);
            cameraEntity.setEulerAngles(camera.angles);
            cameraEntity.camera.fov = camera.fov;
            cameraEntity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();
            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);
            const far = Math.max(dist + boundRadius, 1e-2);
            const near = Math.max(dist - boundRadius, far / (1024 * 16));
            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = Math.min(1.0, near);
        };
        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }
            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);
                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);
                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }
        });
        // Render voxel debug overlay
        app.on('prerender', () => {
            this.voxelOverlay?.update();
        });
        // update state on first frame
        events.on('firstFrame', () => {
            state.animationPaused = !!config.noanim;
            state.loaded = true;
            // the window.* hooks below are the standalone document's api for the thumbnail
            // pipeline and console debugging; an embedded instance keeps them off, since two
            // viewers would overwrite each other's
            if (!config.exposeGlobals)
                return;
            window.scrubTo = async (time) => {
                this.seek(time);
                state.animationPaused = true;
                let onFrame;
                const rendered = new Promise((resolve) => {
                    onFrame = resolve;
                    app.once('frameend', onFrame);
                });
                try {
                    await this.untilDestroyed(rendered);
                }
                finally {
                    app.off('frameend', onFrame);
                }
            };
            window.animationDuration = state.animationDuration;
            // expose the app for console-driven debugging (e.g. scene.gsplat tuning)
            window.app = app;
            // capture hook for the thumbnail pipeline
            window.captureFrame = (options) => this.captureFrame(options);
        });
        const { gsplat } = app.scene;
        // Scene-level gsplat params. Set before any load resolves: streaming starts on the first
        // frame after the gsplat component is created, and lodUpdateAngle / lodBehindPenalty shape
        // which nodes that first pass pulls in.
        // these two allow LOD behind camera to drop, saves lots of splats
        gsplat.lodUpdateAngle = lodUpdateAngle;
        gsplat.lodBehindPenalty = lodBehindPenalty;
        gsplat.minContribution = 1;
        gsplat.alphaClip = 1 / 255;
        gsplat.antiAlias = config.aa;
        // same performance, but rotating on slow devices does not give us unsorted splats on sides
        gsplat.radialSorting = true;
        // apply before streaming starts: this bakes into the work-buffer copies as
        // persistent per-splat data, so the first loaded splats must already carry
        // it (later changes only apply on a full rebuild)
        gsplat.debug = config.colorize ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;
        // Clamp to the coarsest LOD for the fastest possible reveal. This chains off gsplatLoad
        // alone (not the Promise.all below): the octree starts streaming on the first frame after
        // the component is created, and already-requested files are never cancelled — so waiting
        // on skybox/collision here would let a full-detail burst queue up and block the reveal
        // until it has all downloaded. The handler runs as a microtask of the asset's load event,
        // so no frame renders unclamped.
        // Both chains below are started and never awaited, so each needs a rejection handler or
        // a failed load is reported as unhandled. Nothing is logged here: `loadGsplat` already
        // logs its own asset errors, the skybox and collision loads resolve to null on failure,
        // and a destroy mid-load rejects deliberately.
        const ignoreLoadFailure = () => {
            // intentionally ignored
        };
        if (!config.fullload) {
            gsplatLoad.then((entity) => {
                if (this.destroyed)
                    return;
                const gsplatComponent = entity.gsplat;
                const resource = gsplatComponent.resource;
                const lodLevels = resource?.octree?.lodLevels;
                if (lodLevels) {
                    gsplatComponent.lodRangeMax = gsplatComponent.lodRangeMin = lodLevels - 1;
                }
            }, ignoreLoadFailure);
        }
        // Loading progress has to start reporting as soon as the splat data starts streaming,
        // which is well before the reveal. The reveal is wired up in the `Promise.all` below, so
        // it also waits on the skybox and the collision data — and a collision download can take
        // far longer than the splats themselves (ten seconds against under six, on a 4G trace of
        // a real scene), leaving the bar frozen at 0% for the whole wait. Chaining off
        // `gsplatLoad` alone lets the bar track the one load it can measure, from the moment
        // that load begins. The reveal below stops it and puts the bar at 100.
        let stopProgress;
        gsplatLoad.then(() => {
            if (this.destroyed)
                return;
            const eventHandler = app.systems.gsplat;
            // `loading` counts the node files the streamer has requested and not yet made
            // resident. Before the reveal the LOD range is clamped to the coarsest level, so this
            // is a single wave and completed / (completed + in-flight) tracks it directly. A drop
            // in the count is work that finished, or was cancelled, which this cannot tell apart
            // and counts as done. Clamped monotone and capped below 100 so only the reveal fills
            // the bar. See docs/streaming-progress.md for the engine signal that would replace it.
            let prevLoading = 0;
            let completed = 0;
            const progressHandler = (camera, layer, ready, loading) => {
                completed += Math.max(0, prevLoading - loading);
                prevLoading = loading;
                const total = completed + loading;
                if (total > 0) {
                    state.progress = Math.max(state.progress, Math.min(99, Math.trunc((completed / total) * 100)));
                }
            };
            eventHandler.on('frame:ready', progressHandler);
            stopProgress = () => eventHandler.off('frame:ready', progressHandler);
            this.onDestroy(stopProgress);
        }, ignoreLoadFailure);
        // Collision data is not needed to draw the scene, and it can be larger than the splats
        // themselves: 5.65 MB against 4.28 MB for the coarsest LOD level on a traced scene. So
        // it is kept out of the reveal path below, which would otherwise sit on a blank poster
        // with everything needed to render already in memory. `attachCollision` wires it up
        // whenever it lands; the two chains can resolve in either order, so whichever is second
        // performs the attach.
        //
        // Nothing in the opening view depends on it. The scene always starts in `anim` mode, so
        // no collision-dependent controller is entered until the user takes over. Until it
        // attaches, `walkAllowed` stays false so walk mode cannot be entered without the data it
        // needs to place the camera, fly mode has no collision response, and nav targeting falls
        // back to splat depth instead of collision ray hits.
        let collisionReady = null;
        let attachCollision;
        collisionLoad?.then((collision) => {
            if (this.destroyed || !collision)
                return;
            collisionReady = collision;
            attachCollision?.(collision);
        }, ignoreLoadFailure);
        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            // destroyed while loading: the app is gone, so there is nothing to wire up
            if (this.destroyed)
                return;
            const gsplatComponent = results[0].gsplat;
            this.xr.setManipulationTarget(results[0]);
            // get scene bounding box
            const gsplatBbox = gsplatComponent.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
            }
            // the stochastic renderer leaves its frame's depth behind, so no pick pass is needed
            this.picker = this.splatRenderer
                ? new FrameDepthPicker(app, camera, this.splatRenderer)
                : new Picker(app, camera);
            // for development pages (the bench measures pick noise), as splatRenderer:ready
            events.fire('picker:ready', this.picker);
            this.inputController = new InputController(global, this.picker);
            this.cameraManager = new CameraManager(global, sceneBound);
            applyCamera(this.cameraManager.camera);
            if (config.ui) {
                this.navCursor = new NavCursor(app, camera, null, events, state, config.reticle);
            }
            // hasCollision = collision data exists (drives fly-mode collision
            // detection and the voxel/mesh debug overlay availability).
            // walkAllowed = walk mode is offered to the user; requires both
            // collision data and a scene large enough to walk around in.
            attachCollision = (collision) => {
                this.inputController.collision = collision;
                this.cameraManager.setCollision(collision);
                if (this.navCursor) {
                    this.navCursor.collision = collision;
                }
                state.hasCollision = true;
                state.walkAllowed = isWalkAllowed(sceneBound, collision);
                // Create collision debug overlay (voxel uses a compute shader, mesh
                // uses standard line rendering). The voxel path requires WebGPU.
                if (collision instanceof VoxelCollision && renderer !== 'webgl') {
                    const setOverlayEnabled = (value) => {
                        // Upload the voxel data and allocate the screen-sized texture only
                        // when the debug overlay is first used.
                        if (value && !this.voxelOverlay) {
                            this.voxelOverlay = new VoxelDebugOverlay(app, collision, camera);
                            this.voxelOverlay.mode = config.heatmap ? 'heatmap' : 'overlay';
                        }
                        if (this.voxelOverlay)
                            this.voxelOverlay.enabled = value;
                        app.renderNextFrame = true;
                    };
                    events.on('collisionOverlayEnabled:changed', setOverlayEnabled);
                    state.hasCollisionOverlay = true;
                    setOverlayEnabled(state.collisionOverlayEnabled);
                }
                else if (collision instanceof MeshCollision) {
                    this.meshOverlay = new MeshDebugOverlay(app, collision, camera, !!this.cameraFrame);
                    state.hasCollisionOverlay = true;
                    events.on('collisionOverlayEnabled:changed', (value) => {
                        this.meshOverlay.enabled = value;
                        app.renderNextFrame = true;
                    });
                }
                app.renderNextFrame = true;
            };
            // collision may already have landed while the splats were still streaming
            if (collisionReady)
                attachCollision(collisionReady);
            this.debugPanel = new DebugPanel(global, this.cameraManager, this.picker, this.splatRenderer, {
                shown: () => !!this.miniStats?.enabled,
                show: (value) => this.setMiniStats(value)
            });
            const applyPerfSettings = () => {
                const budget = () => {
                    if (config.budget !== undefined && Number.isFinite(config.budget) && config.budget > 0) {
                        return config.budget;
                    }
                    if (standaloneHeadset && state.xrMode !== null) {
                        return standaloneXrBudget;
                    }
                    const quality = platform.mobile ? budgets.mobile : budgets.desktop;
                    return state.performanceMode ? quality.low : quality.high;
                };
                gsplat.splatBudget = budget() * 1000000;
                gsplat.colorUpdateAngle = state.performanceMode ? 1 : 0.2;
                gsplat.lodBehindPenalty = state.xrMode === null ? lodBehindPenalty : 1;
                gsplat.lodUpdateAngle = state.xrMode === null ? lodUpdateAngle : 0;
                gsplatComponent.lodRangeMin = 0;
                gsplatComponent.lodRangeMax = 1000;
                // request a frame so the param changes are processed (full work-buffer
                // rebuild) even when on-demand rendering is active and the camera is idle
                app.renderNextFrame = true;
            };
            if (config.fullload) {
                // reveal once full quality has finished loading (used for screenshots)
                applyPerfSettings();
            }
            const eventHandler = app.systems.gsplat;
            // Once on demand (autoRender is disabled at ready, below), render when gsplat streaming
            // produces new data a render would show (new LOD/world-state, pending sort). This also
            // keeps work-buffer texture lifetime coupled to the submit under app.autoRender = false.
            eventHandler.on('frame:request', () => {
                app.renderNextFrame = true;
            });
            // `ready && loading === 0` describes the state before streaming starts just as well
            // as the state after it finishes: on the first frame the octree instance has not run
            // its LOD pass yet, so nothing is in flight and the world trivially reports ready.
            // Taken at face value that revealed the scene on the first event, before a single
            // frame had rendered, which both skipped the whole loading bar and undid the coarse
            // LOD clamp above by running applyPerfSettings immediately. So require evidence that
            // the streamer has left that initial state: work in flight, or splats on screen.
            // Only octree content has a streaming phase to wait for; single-file content is fully
            // loaded before this handler is registered, so it must not be gated.
            const octree = gsplatComponent.resource?.octree ?? null;
            let streamingStarted = !octree;
            const readyHandler = (camera, layer, ready, loading) => {
                // `frame.gsplats` is the rendered splat count, the same stat the ministats panel
                // above reads. It covers an octree that renders before it reports work in flight.
                if (loading > 0 || app.stats.frame.gsplats > 0) {
                    streamingStarted = true;
                }
                if (ready && loading === 0 && streamingStarted) {
                    // scene is done with initial/reveal loading
                    eventHandler.off('frame:ready', readyHandler);
                    stopProgress?.();
                    state.progress = 100;
                    // switch to on-demand rendering (frame:request + camera-change detection)
                    app.autoRender = false;
                    // handle quality mode changes
                    events.on('performanceMode:changed', applyPerfSettings);
                    events.on('xrMode:changed', applyPerfSettings);
                    applyPerfSettings();
                    // the stochastic renderer consumes the engine's world under whatever
                    // renderer mode the engine resolved; switching modes here would rebuild
                    // the work buffer for nothing
                    if (!this.splatRenderer) {
                        gsplat.renderer = rendererTable[renderer];
                    }
                    // wait for the first valid frame to complete rendering
                    app.once('frameend', () => {
                        events.fire('firstFrame');
                        // emit first frame event on window
                        window.firstFrame?.();
                    });
                }
            };
            eventHandler.on('frame:ready', readyHandler);
        }, ignoreLoadFailure);
    }
    requireAlive(method) {
        if (this.destroyed) {
            throw new Error(`${method}: the viewer has been destroyed`);
        }
    }
    requireLoaded(method) {
        this.requireAlive(method);
        if (!this.global.state.loaded) {
            throw new Error(`${method}: the viewer is not loaded`);
        }
    }
    frameScene() {
        this.requireLoaded('frameScene');
        this.global.events.fire('inputEvent', 'frame');
    }
    resetCamera() {
        this.requireLoaded('resetCamera');
        this.global.events.fire('inputEvent', 'reset');
    }
    toggleWalk() {
        this.requireLoaded('toggleWalk');
        this.global.events.fire('inputEvent', 'toggleWalk');
    }
    selectAnnotation(index) {
        this.requireLoaded('selectAnnotation');
        const { settings, state, app } = this.global;
        if (index !== null) {
            if (!Number.isInteger(index) || index < 0 || index >= settings.annotations.length) {
                throw new RangeError('selectAnnotation: index must be an integer in range or null');
            }
            this.cameraManager.selectAnnotation(settings.annotations[index]);
        }
        state.selectedAnnotation = index;
        app.renderNextFrame = true;
    }
    setMoveInput(x, z) {
        this.requireLoaded('setMoveInput');
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
            throw new Error('setMoveInput: axes must be finite numbers');
        }
        this.inputController.setMoveInput(Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, z)));
    }
    async requestFullscreen() {
        this.requireAlive('requestFullscreen');
        return this.untilDestroyed(this.fullscreen.request());
    }
    async exitFullscreen() {
        this.requireAlive('exitFullscreen');
        return this.untilDestroyed(this.fullscreen.exit());
    }
    async startXR(mode) {
        this.requireLoaded('startXR');
        return this.xr.start(mode);
    }
    async endXR() {
        this.requireAlive('endXR');
        return this.xr.end();
    }
    seek(time) {
        this.requireLoaded('seek');
        const { state, app } = this.global;
        if (!state.hasAnimation) {
            throw new Error('seek: no animation track');
        }
        if (!Number.isFinite(time)) {
            throw new Error('seek: time must be finite');
        }
        this.cameraManager.seek(time);
        app.renderNextFrame = true;
    }
    /**
     * Render the scene, with post effects, into an offscreen supersampled target, GPU
     * box-downsample it to the requested size and return just that small buffer. Waits for
     * the first frame. The capture target is created lazily on first use — no flag and no
     * preserveDrawingBuffer needed, and it works on both WebGL and WebGPU.
     */
    captureFrame({ time, width = 480, height = width, supersample } = {}) {
        const run = async () => {
            await this.ready;
            if (this.destroyed) {
                throw new Error('captureFrame: the viewer has been destroyed');
            }
            const { app, camera, state } = this.global;
            if (!this.capture) {
                this.capture = new Capture(app, camera.camera, () => this.cameraFrame ?? null);
            }
            const grab = this.capture.grab({
                time,
                width,
                height,
                supersample,
                scrub: (t) => {
                    if (state.hasAnimation) {
                        state.animationPaused = true;
                        this.seek(t);
                    }
                }
            });
            return this.untilDestroyed(grab);
        };
        const result = this.captureQueue.then(run, run);
        this.captureQueue = result.then(() => {
            // intentionally ignored
        }, () => {
            // intentionally ignored
        });
        return result;
    }
    /**
     * Settle `work` when the viewer is destroyed, whatever it is waiting on. Racing rather than
     * cancelling, because the waits are the engine's; `work` runs on to completion unobserved,
     * and the race counts as its handler, so a late failure is not reported as unhandled.
     */
    untilDestroyed(work) {
        let onAbort;
        const aborted = new Promise((_resolve, reject) => {
            onAbort = reject;
        });
        this.abortHandlers.add(onAbort);
        return Promise.race([work, aborted]).finally(() => {
            // releases the signal, and with it this race and its result
            this.abortHandlers.delete(onAbort);
        });
    }
    /**
     * Register cleanup to run from {@link destroy}, for things the caller set up around the
     * viewer (the canvas resize observer, document-level listeners). Runs immediately if the
     * viewer is already destroyed.
     *
     * @param fn - Cleanup to run.
     */
    onDestroy(fn) {
        if (this.destroyed) {
            fn();
            return;
        }
        this.disposers.push(fn);
    }
    /**
     * Show or hide the engine's MiniStats panel. While shown the viewer renders every frame, so
     * the graphs keep moving.
     */
    setMiniStats(value) {
        if (value === !!this.miniStats?.enabled)
            return;
        // hidden by disabling rather than destroying: the engine's destroy() leaves its stats
        // timers reading every frame and its buffers allocated, so a panel per toggle would pile
        // them up until teardown
        if (this.miniStats) {
            this.miniStats.enabled = value;
            // the panel's transparent div would keep catching clicks over the canvas
            this.miniStats.div.style.display = value ? '' : 'none';
            if (value) {
                // enabling turns every graph on, the text-only size's too: its size puts them back
                const size = this.miniStats.activeSizeIndex;
                this.miniStats.activeSizeIndex = size;
                this.global.app.renderNextFrame = true;
            }
            return;
        }
        const options = MiniStats.getDefaultOptions();
        options.cpu.enabled = false;
        options.stats = options.stats.filter((s) => s.name !== 'DrawCalls');
        options.stats.push({
            name: 'VRAM',
            stats: ['vram.tex'],
            decimalPlaces: 1,
            multiplier: 1 / (1024 * 1024),
            unitsName: 'MB',
            watermark: 1024
        }, {
            name: 'Splats',
            stats: ['frame.gsplats'],
            decimalPlaces: 3,
            multiplier: 1 / 1000000,
            unitsName: 'M',
            watermark: 5
        });
        this.miniStats = new MiniStats(this.global.app, options);
        this.global.app.renderNextFrame = true;
    }
    /**
     * Tear the viewer down: stop rendering, remove every listener it added to the window,
     * document and canvas, restore the globals it patched, and release the graphics device.
     * Safe to call before loading has finished, and idempotent.
     *
     * Finally removes the instance root, and with it the canvas and ui subtree createViewer
     * built. Their element listeners go with them.
     */
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        // settle anything waiting on an engine event, before the handlers go
        const gone = () => new Error('the viewer has been destroyed');
        this.failReady(gone());
        for (const onAbort of this.abortHandlers) {
            onAbort(gone());
        }
        this.abortHandlers.clear();
        const { app } = this.global;
        this.fullscreen.destroy();
        this.xr.destroy();
        // subsystems holding listeners on the canvas, window or document, or gpu resources
        // outside the entity hierarchy
        this.debugPanel?.destroy();
        this.navCursor?.destroy();
        this.inputController?.destroy();
        this.voxelOverlay?.destroy();
        this.meshOverlay?.destroy();
        this.picker?.release();
        this.splatRenderer?.destroy();
        this.splatRenderer = null;
        this.capture?.destroy();
        this.capture = null;
        if (this.cameraFrame) {
            this.cameraFrame.destroy();
            this.cameraFrame = null;
        }
        // configureCamera registers our device with the backbuffer srgb patch
        setBackBufferSrgb(app.graphicsDevice, false);
        // caller cleanup, in reverse registration order
        for (const dispose of this.disposers.reverse()) {
            dispose();
        }
        this.disposers.length = 0;
        // the first-frame globals, only if they are ours: a later instance may own them
        if (window.app === app) {
            delete window.app;
            delete window.scrubTo;
            delete window.captureFrame;
            delete window.animationDuration;
        }
        // The engine's destroy releases its own resources but leaves the underlying handle to
        // the garbage collector: the WebGL context is nulled, not lost, and the WebGPU device
        // is not destroyed. Browsers cap live WebGL contexts at around 16, so release both
        // explicitly once the engine is done with them. The canvas cannot host another
        // context type anyway. The engine's device-lost handler ignores a `destroyed` reason.
        const handles = app.graphicsDevice;
        const gl = handles.gl ?? null;
        const wgpu = handles.wgpu ?? null;
        // entities (including the annotation scripts), input, assets, xr, the device and every
        // app event handler
        app.destroy();
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        wgpu?.destroy();
        this.global.root.remove();
    }
    // configure camera based on application mode and post process settings
    configureCamera(settings) {
        const { global } = this;
        const { app, config, camera, state } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;
        // hpr override takes precedence over settings.highPrecisionRendering
        const highPrecisionRendering = config.hpr ?? settings.highPrecisionRendering;
        const postFxRequested = !config.nofx && (anyPostEffectEnabled(postEffectSettings) || highPrecisionRendering);
        // CameraFrame has no XR path, so post effects are off for the session
        const enableCameraFrame = state.xrMode === null && postFxRequested;
        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }
            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = highPrecisionRendering
                ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F]
                : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            cameraFrame.update();
            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunkGlsl);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', gammaChunkWgsl);
            // force skybox shader to write gamma-space colors (inline pow replaces the
            // gammaCorrectOutput call which is a no-op under CameraFrame's GAMMA_NONE)
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('skyboxPS', patchChunk(this.origChunks.glsl.skyboxPS, 'gammaCorrectOutput(toneMap(processEnvironment(linear)))', 'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3(1.0 / 2.2))', 'glsl skyboxPS gamma override'));
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('skyboxPS', patchChunk(this.origChunks.wgsl.skyboxPS, 'gammaCorrectOutput(toneMap(processEnvironment(linear)))', 'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3f(1.0 / 2.2))', 'wgsl skyboxPS gamma override'));
            // ensure the final compose blit doesn't perform linear->gamma conversion.
            setBackBufferSrgb(app.graphicsDevice, true);
            camera.camera.clearColor = new Color(background.color);
        }
        else {
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }
            // restore shader chunks to engine defaults
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', this.origChunks.glsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', this.origChunks.wgsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('skyboxPS', this.origChunks.glsl.skyboxPS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('skyboxPS', this.origChunks.wgsl.skyboxPS);
            // restore original isColorBufferSrgb behavior
            setBackBufferSrgb(app.graphicsDevice, false);
            camera.camera.toneMapping = tonemapTable[settings.tonemapping];
            // AR composites the scene over the passthrough view
            camera.camera.clearColor = state.xrMode === 'ar' ? new Color(0, 0, 0, 0) : new Color(background.color);
        }
        // the sky would cover AR's passthrough view entirely, so it is hidden for the session
        const skyLayer = app.scene.layers.getLayerById(LAYERID_SKYBOX);
        if (skyLayer)
            skyLayer.enabled = state.xrMode !== 'ar';
        // Mesh overlay bakes its vertex colors based on the current gamma
        // path; reapply when CameraFrame is created/destroyed (e.g. on XR
        // start/end) so the overlay tracks the new path.
        this.meshOverlay?.setCameraFrameEnabled(!!this.cameraFrame);
    }
}

// The filename's extension selects the gsplat parser, so a url with no usable name (a data:
// uri) needs the config to name its content instead; falsy (an empty name) falls back to the
// url-derived name.
const contentName = (contentUrl, contentFilename) => contentFilename || new URL(contentUrl, location.href).pathname.split('/').pop();
// Whether a prefetched response for this content is worth starting. The engine's octree parser
// fetches lod-meta.json itself and ignores `asset.file.contents`, so prefetching it downloads
// the metadata twice — a quarter of a megabyte on a real scene, served with no cache-control
// header, so the second request is not a cache hit. Every other splat parser consumes the
// prefetched response, so they keep the head start. `src/index.html` applies the same rule when
// it starts its own prefetch, and docs/streaming-progress.md covers the engine fix that would
// let the octree path reuse the response instead of opting out of it.
const isPrefetchable = (contentUrl, contentFilename) => contentName(contentUrl, contentFilename)?.toLowerCase() !== 'lod-meta.json';
const loadGsplat = async (app, config, progressCallback, cancelled) => {
    const { contents, contentUrl, contentFilename } = config;
    const c = contents;
    const filename = contentName(contentUrl, contentFilename);
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
    // Reading that metadata spans a network round trip, so a destroy can land in the middle of
    // it. `app.destroy()` nulls the asset registry, so registering the asset now would throw
    // from the engine's internals; reject instead, which the viewer's load chains expect.
    if (cancelled()) {
        throw new Error('loadGsplat: the viewer was destroyed while loading');
    }
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);
    return new Promise((resolve, reject) => {
        asset.on('load', () => {
            // always name the app: the engine's default is the most recently created one,
            // which is another viewer's when two share a page
            const entity = new Entity('gsplat', app);
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: true,
                asset
            });
            app.root.addChild(entity);
            resolve(entity);
        });
        let watermark = 0;
        asset.on('progress', (received, length) => {
            const progress = Math.min(1, received / length) * 100;
            if (progress > watermark) {
                watermark = progress;
                progressCallback(Math.trunc(watermark));
            }
        });
        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
};
const loadSkybox = (app, url) => {
    return new Promise((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });
        asset.on('load', () => {
            resolve(asset);
        });
        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });
        app.assets.add(asset);
        app.assets.load(asset);
    });
};
const createApp = async (canvas, config) => {
    const useWebGPU = config.renderer === 'webgpu';
    // Create the graphics device. The engine auto-appends WebGL2/null fallbacks
    // when WebGPU isn't supported. Request xrCompatible so the device — WebGPU
    // (via XRGPUBinding) or the WebGL fallback — is usable for AR/VR.
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: useWebGPU ? ['webgpu'] : [],
        antialias: false,
        depth: true,
        stencil: false,
        xrCompatible: true,
        powerPreference: 'high-performance'
    });
    console.log(`Renderer: ${device.deviceType}`);
    // The engine may have fallen back from WebGPU to WebGL2; downstream code
    // (voxel overlay, XR, gsplat renderer selection) needs the *actual* renderer.
    const renderer = device.deviceType === 'webgpu' ? 'webgpu' : 'webgl';
    // Set maxPixelRatio so the XR framebuffer scale factor is computed correctly.
    // Regular rendering bypasses maxPixelRatio via the custom initCanvas sizing.
    device.maxPixelRatio = window.devicePixelRatio;
    // Create the application
    const app = new App(canvas, {
        graphicsDevice: device,
        mouse: new Mouse(canvas),
        touch: new TouchDevice$1(canvas),
        keyboard: new Keyboard(window)
    });
    // The stochastic renderer never sorts on the cpu, so the per-splat centres the engine
    // reads back for its cpu sort (12 bytes each, plus a gpu readback per file) are dead
    // weight. Read once per file at load, so it has to be set before any asset loads.
    if (config.stochastic && renderer === 'webgpu') {
        app.scene.gsplatCentersEnabled = false;
    }
    // enable anonymous CORS for image loading in safari (must be set before any
    // texture asset starts loading, otherwise the <img> is fetched without the
    // crossorigin attribute and WebGL rejects it with SecurityError)
    app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';
    // Create entity hierarchy
    const cameraRoot = new Entity('camera root', app);
    app.root.addChild(cameraRoot);
    const camera = new Entity('camera', app);
    cameraRoot.addChild(camera);
    const light = new Entity('light', app);
    light.setEulerAngles(35, 45, 0);
    light.addComponent('light', {
        color: new Color(1.0, 0.98, 0.957),
        intensity: 1
    });
    app.root.addChild(light);
    app.scene.ambientLight.set(0.51, 0.55, 0.65);
    return { app, camera, renderer };
};
// measure the canvas's css size. a hidden canvas (e.g. inside a display:none
// iframe) measures 0×0 — resizeCanvas skips those, keeping the current backing
// size until the resize observer reports a real layout
const measureCanvas = (canvas) => ({
    width: canvas.clientWidth,
    height: canvas.clientHeight
});
// size the canvas backbuffer from a css size: scaled by the pixel ratio (capped to
// limit resolution on high-DPI devices), halved in performance mode. a zero css size
// (hidden canvas) is skipped — the canvas keeps its previous size, as a zero-sized
// swap chain is invalid in webgpu.
const resizeCanvas = (canvas, cssSize, performanceMode) => {
    if (!cssSize.width || !cssSize.height)
        return;
    // maximum pixel dimension we will allow along the shortest screen dimension based on platform
    const maxPixelDim = platform.mobile ? 1080 : 2160;
    const pixelRatio = Math.min(maxPixelDim / Math.min(screen.width, screen.height), window.devicePixelRatio);
    const scale = pixelRatio * (performanceMode ? 0.5 : 1.0);
    const width = Math.ceil(cssSize.width * scale);
    const height = Math.ceil(cssSize.height * scale);
    if (width !== canvas.width || height !== canvas.height) {
        canvas.width = width;
        canvas.height = height;
    }
};
// initialize canvas size and resizing
const initCanvas = (global) => {
    const { app, events, state } = global;
    const { canvas } = app.graphicsDevice;
    // the canvas css size, kept current by the resize observer. measured directly at
    // startup so the first frames are sized before the observer's first delivery.
    const cssSize = measureCanvas(canvas);
    const apply = () => {
        // don't resize the canvas during XR - the XR system manages its own framebuffers
        // and resetting canvas dimensions can invalidate the XRWebGLLayer
        if (app.xr?.active)
            return;
        resizeCanvas(canvas, cssSize, state.performanceMode);
    };
    const resizeObserver = new ResizeObserver((entries) => {
        const e = entries[0]?.contentBoxSize?.[0];
        // ignore hidden deliveries (0×0), keeping the last real size
        if (e && e.inlineSize && e.blockSize) {
            cssSize.width = e.inlineSize;
            cssSize.height = e.blockSize;
            app.renderNextFrame = true;
        }
    });
    resizeObserver.observe(canvas);
    events.on('performanceMode:changed', () => {
        app.renderNextFrame = true;
    });
    // Resize canvas before render() so the swap chain texture is acquired at the correct size.
    app.on('framerender', apply);
    // Disable the engine's built-in canvas resize — we handle it via ResizeObserver
    app._allowResize = false;
    apply();
    return () => resizeObserver.disconnect();
};
const createImage = (url) => {
    const img = new Image();
    img.src = url;
    return img;
};
// the options with every default applied
const resolveConfig = (options) => ({
    contentUrl: options.contentUrl,
    contentFilename: options.contentFilename,
    posterUrl: options.posterUrl,
    skyboxUrl: options.skyboxUrl,
    collisionUrl: options.collisionUrl,
    poster: options.poster ?? (options.posterUrl ? createImage(options.posterUrl) : undefined),
    contents: options.contents ??
        (isPrefetchable(options.contentUrl, options.contentFilename) ? fetch(options.contentUrl) : undefined),
    renderer: options.renderer ?? 'webgpu',
    ui: options.ui ?? true,
    reticle: options.reticle ?? false,
    noanim: options.noanim ?? false,
    nofx: options.nofx ?? false,
    hpr: options.hpr,
    ministats: options.ministats ?? false,
    colorize: options.colorize ?? false,
    fullload: options.fullload ?? false,
    aa: options.aa ?? false,
    stochastic: options.stochastic ?? false,
    splatSource: options.splatSource ?? 'workbuffer',
    variant: options.variant ?? '',
    budget: options.budget,
    heatmap: options.heatmap ?? false,
    debug: options.debug ?? false,
    lang: options.lang,
    exposeGlobals: options.exposeGlobals ?? false
});
const createViewer = async (options) => {
    const { container } = options;
    const config = resolveConfig(options);
    // the instance root. The canvas and the ui markup are siblings under it, which scopes
    // everything the viewer looks up or attaches in the dom; the viewer owns it outright, so
    // nothing on the host's own element is read or written, and destroy() removes it whole
    const root = document.createElement('div');
    root.className = 'sse-viewer';
    if (config.ui) {
        root.innerHTML = uiHtml;
    }
    else {
        root.appendChild(document.createElement('canvas'));
    }
    container.appendChild(root);
    const canvas = root.querySelector('canvas');
    // create events
    const events = new EventHandler();
    // the poster covers the hidden canvas from the first moment, before the graphics device
    // exists. It is part of the ui, so a headless instance shows the canvas from the start and
    // its host covers the wait however it likes
    if (config.poster && config.ui) {
        initPoster(root, config.poster, events);
    }
    // resolve settings after showing the poster, including a fetch started by the document
    const settingsJson = typeof options.settings === 'string' ? await (await fetch(options.settings)).json() : await options.settings;
    const preferences = readPreferences(platform.mobile);
    // size the canvas backbuffer before the graphics device is created, so the swap
    // chain and any backbuffer-sized resources start at the correct resolution instead
    // of being recreated on the first frame's resize. a hidden embed keeps the default
    // canvas size here; the resize observer sizes it on reveal
    resizeCanvas(canvas, measureCanvas(canvas), preferences.performanceMode);
    const { app, camera, renderer } = await createApp(canvas, config);
    // translate the markup and get this instance's string lookup, before the ui reads any
    const localize = initLocalization(config.lang, root);
    const state = observe(events, {
        loaded: false,
        ...preferences,
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        canStartAR: false,
        canStartVR: false,
        xrMode: null,
        hasCollision: false,
        hasCollisionOverlay: false,
        walkAllowed: false,
        collisionOverlayEnabled: false,
        isFullscreen: false,
        controlsHidden: false,
        selectedAnnotation: null,
        inputEnabled: true
    });
    const global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera,
        renderer,
        root,
        localize
    };
    const disposeCanvas = initCanvas(global);
    // start the application
    app.start();
    camera.addComponent('camera');
    // a load continuation can outlive a destroy, so anything that resumes after an await checks
    // this before touching the app
    let destroyed = false;
    // Load model
    const gsplatLoad = loadGsplat(app, config, (progress) => {
        state.progress = progress;
    }, () => destroyed);
    // Load skybox (continue without if it fails — e.g. CORS, 404)
    const skyboxLoad = config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl)
            .then((asset) => {
            app.scene.envAtlas = asset.resource;
        })
            .catch((err) => {
            console.warn('Failed to load skybox:', err);
        });
    // Load collision data (type determined by file extension)
    let collisionLoad;
    if (config.collisionUrl) {
        const ext = new URL(config.collisionUrl, location.href).pathname.split('.').pop()?.toLowerCase();
        if (ext === 'glb') {
            collisionLoad = MeshCollision.fromGlb(app, config.collisionUrl).catch((err) => {
                console.warn('Failed to load mesh collision:', err);
                return null;
            });
        }
        else {
            collisionLoad = loadVoxelCollision(config.collisionUrl).catch((err) => {
                console.warn('Failed to load voxel data:', err);
                return null;
            });
        }
    }
    // Load and play sound
    let disposeAudio;
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        const unlock = () => {
            if (sound) {
                sound.play();
            }
        };
        root.addEventListener('click', unlock, {
            capture: true,
            once: true
        });
        disposeAudio = () => {
            root.removeEventListener('click', unlock, { capture: true });
            sound.pause();
        };
    }
    // Create the viewer
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad, collisionLoad);
    viewer.onDestroy(persistPreferences(events));
    const handle = {
        app,
        state,
        events,
        annotations: global.settings.annotations,
        captureFrame: (captureOptions) => viewer.captureFrame(captureOptions),
        seek: (time) => viewer.seek(time),
        frameScene: () => viewer.frameScene(),
        resetCamera: () => viewer.resetCamera(),
        toggleWalk: () => viewer.toggleWalk(),
        selectAnnotation: (index) => viewer.selectAnnotation(index),
        setMoveInput: (x, z) => viewer.setMoveInput(x, z),
        requestFullscreen: () => viewer.requestFullscreen(),
        exitFullscreen: () => viewer.exitFullscreen(),
        startXR: (mode) => viewer.startXR(mode),
        endXR: () => viewer.endXR(),
        destroy: () => viewer.destroy()
    };
    // The built-in controls use the same handle returned to an embedding host.
    const disposeUI = config.ui
        ? initUI(global, handle, () => viewer.picker, () => viewer.cameraManager?.transitionProgress() ?? 1)
        : null;
    viewer.onDestroy(() => {
        destroyed = true;
    });
    viewer.onDestroy(disposeCanvas);
    if (disposeUI) {
        viewer.onDestroy(disposeUI);
    }
    if (disposeAudio) {
        viewer.onDestroy(disposeAudio);
    }
    return handle;
};
console.log(`SuperSplat Viewer v${version} | Engine v${version$1} (${revision})`);

export { createViewer };
//# sourceMappingURL=viewer.js.map
