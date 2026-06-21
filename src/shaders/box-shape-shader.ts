const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main() {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    // ray-box intersection in local space (axis-aligned box from -0.5 to 0.5)
    bool intersectBoxLocal(out float t0, out float t1, out int axis0, out int axis1, vec3 pos, vec3 dir)
    {
        vec3 boxLen = vec3(0.5);
        bvec3 validDir = notEqual(dir, vec3(0.0));
        vec3 absDir = abs(dir);
        vec3 signDir = sign(dir);
        vec3 m = vec3(
            validDir.x ? 1.0 / absDir.x : 0.0,
            validDir.y ? 1.0 / absDir.y : 0.0,
            validDir.z ? 1.0 / absDir.z : 0.0
        ) * signDir;

        vec3 n = m * pos;
        vec3 k = abs(m) * boxLen;

        vec3 v0 = -n - k;
        vec3 v1 = -n + k;

        v0 = mix(vec3(-1.0 / 0.0000001), v0, validDir);
        v1 = mix(vec3(1.0 / 0.0000001), v1, validDir);

        axis0 = (v0.x > v0.y) ? ((v0.x > v0.z) ? 0 : 2) : ((v0.y > v0.z) ? 1 : 2);
        axis1 = (v1.x < v1.y) ? ((v1.x < v1.z) ? 0 : 2) : ((v1.y < v1.z) ? 1 : 2);

        t0 = v0[axis0];
        t1 = v1[axis1];

        if (t0 > t1 || t1 < 0.0) {
            return false;
        }

        return true;
    }

    float calcDepth(in vec3 pos, in mat4 viewProjection) {
        vec4 v = viewProjection * vec4(pos, 1.0);
        return (v.z / v.w) * 0.5 + 0.5;
    }

    uniform sampler2D blueNoiseTex32;
    uniform mat4 matrix_viewProjection;
    uniform mat4 matrix_model;
    uniform mat4 matrix_model_inv;

    uniform vec3 near_origin;
    uniform vec3 near_x;
    uniform vec3 near_y;

    uniform vec3 far_origin;
    uniform vec3 far_x;
    uniform vec3 far_y;

    uniform vec2 targetSize;
    uniform vec3 shapeColor;

    bool writeDepth(float alpha) {
        ivec2 uv = ivec2(gl_FragCoord.xy);
        ivec2 size = textureSize(blueNoiseTex32, 0);
        return alpha > texelFetch(blueNoiseTex32, uv % size, 0).y;
    }

    bool edgeStrips(vec3 pos, int axis) {
        // Only draw lines at the outer edges of each face, not at the center
        // pos is in local space [-0.5, 0.5]
        float edgeThreshold = 0.015;
        vec3 absPos = abs(pos);
        // Check if close to any edge (near 0.5)
        vec3 edgeDist = abs(absPos - 0.5);
        bvec3 onEdge = lessThan(edgeDist, vec3(edgeThreshold));
        onEdge[axis] = false;
        return any(onEdge);
    }

    bool internalGrid(vec3 worldPos, int faceAxis) {
        // Fixed-size internal grid in world space, unaffected by box scaling
        // Only draw grid lines on the two axes parallel to the face (not the face normal axis)
        float gridSize = 1.0;
        float lineWidth = 0.02;
        vec3 p = abs(worldPos);
        vec3 f = fract(p / gridSize);
        bvec3 onLine = lessThan(f, vec3(lineWidth / gridSize));
        // Disable grid lines along the face normal axis to avoid concentric rings
        onLine[faceAxis] = false;
        return any(onLine);
    }

    void main() {
        vec2 clip = gl_FragCoord.xy / targetSize;
        vec3 worldNear = near_origin + near_x * clip.x + near_y * clip.y;
        vec3 worldFar = far_origin + far_x * clip.x + far_y * clip.y;
        vec3 worldDir = normalize(worldFar - worldNear);

        // Transform ray into box local space
        vec3 localNear = (matrix_model_inv * vec4(worldNear, 1.0)).xyz;
        vec3 localFar = (matrix_model_inv * vec4(worldFar, 1.0)).xyz;
        vec3 localDir = normalize(localFar - localNear);

        float t0, t1;
        int axis0, axis1;
        if (!intersectBoxLocal(t0, t1, axis0, axis1, localNear, localDir)) {
            discard;
        }

        vec3 localFront = localNear + localDir * t0;
        bool frontGrid = t0 > 0.0 ? internalGrid((matrix_model * vec4(localFront, 1.0)).xyz, axis0) : false;
        bool front = t0 > 0.0 && (edgeStrips(localFront, axis0) || frontGrid);

        vec3 localBack = localNear + localDir * t1;
        bool backGrid = internalGrid((matrix_model * vec4(localBack, 1.0)).xyz, axis1);
        bool back = edgeStrips(localBack, axis1) || backGrid;

        if (front) {
            vec3 worldFront = (matrix_model * vec4(localFront, 1.0)).xyz;
            gl_FragColor = vec4(shapeColor, 0.6);
            gl_FragDepth = writeDepth(0.6) ? calcDepth(worldFront, matrix_viewProjection) : 1.0;
        } else if (back) {
            vec3 worldBack = (matrix_model * vec4(localBack, 1.0)).xyz;
            gl_FragColor = vec4(shapeColor * 0.0, 0.6);
            gl_FragDepth = writeDepth(0.6) ? calcDepth(worldBack, matrix_viewProjection) : 1.0;
        } else {
            discard;
        }
    }
`;

export { vertexShader, fragmentShader };
