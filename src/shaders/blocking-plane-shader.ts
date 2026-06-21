const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main() {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    // ray-plane intersection in local space (plane at y=0)
    bool intersectPlaneLocal(out float t, vec3 pos, vec3 dir)
    {
        // Plane is at y=0 in local space
        if (abs(dir.y) < 0.0001) {
            return false; // Ray is parallel to plane
        }
        t = -pos.y / dir.y;
        return t > 0.0;
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

    void main() {
        vec2 clip = gl_FragCoord.xy / targetSize;
        vec3 worldNear = near_origin + near_x * clip.x + near_y * clip.y;
        vec3 worldFar = far_origin + far_x * clip.x + far_y * clip.y;
        vec3 worldDir = normalize(worldFar - worldNear);

        // Transform ray into plane local space
        vec3 localNear = (matrix_model_inv * vec4(worldNear, 1.0)).xyz;
        vec3 localFar = (matrix_model_inv * vec4(worldFar, 1.0)).xyz;
        vec3 localDir = normalize(localFar - localNear);

        float t;
        if (!intersectPlaneLocal(t, localNear, localDir)) {
            discard;
        }

        vec3 localHit = localNear + localDir * t;
        
        // Check if hit point is within plane bounds (-0.5 to 0.5 in x and z)
        if (abs(localHit.x) > 0.5 || abs(localHit.z) > 0.5) {
            discard;
        }

        vec3 worldHit = (matrix_model * vec4(localHit, 1.0)).xyz;
        
        // Draw grid pattern
        float gridSize = 0.5;
        vec2 gridPos = localHit.xz / gridSize;
        vec2 gridFract = fract(gridPos);
        float lineWidth = 0.05;
        bool onGrid = gridFract.x < lineWidth || gridFract.y < lineWidth;
        
        // Draw border
        float border = 0.02;
        bool onBorder = abs(localHit.x) > 0.5 - border || abs(localHit.z) > 0.5 - border;
        
        if (onBorder) {
            gl_FragColor = vec4(shapeColor, 0.8);
            gl_FragDepth = writeDepth(0.8) ? calcDepth(worldHit, matrix_viewProjection) : 1.0;
        } else if (onGrid) {
            gl_FragColor = vec4(shapeColor, 0.3);
            gl_FragDepth = writeDepth(0.3) ? calcDepth(worldHit, matrix_viewProjection) : 1.0;
        } else {
            gl_FragColor = vec4(shapeColor, 0.1);
            gl_FragDepth = writeDepth(0.1) ? calcDepth(worldHit, matrix_viewProjection) : 1.0;
        }
    }
`;

export { vertexShader, fragmentShader };
