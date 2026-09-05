const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    void main() {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    // Ray-sphere intersection in local space (unit sphere at origin, radius 0.5)
    bool intersectSphereLocal(out float t0, out float t1, vec3 pos, vec3 dir) {
        float r = 0.5;
        float tca = dot(-pos, dir);
        float d2 = r * r - (dot(pos, pos) - tca * tca);
        if (d2 <= 0.0) {
            return false;
        }
        float thc = sqrt(d2);
        t0 = tca - thc;
        t1 = tca + thc;
        if (t1 <= 0.0) {
            return false;
        }
        return true;
    }

    float calcDepth(in vec3 pos, in mat4 viewProjection) {
        vec4 v = viewProjection * vec4(pos, 1.0);
        return (v.z / v.w) * 0.5 + 0.5;
    }

    vec2 calcAzimuthElev(in vec3 dir) {
        float azimuth = atan(dir.z, dir.x);
        float elev = asin(dir.y);
        return vec2(azimuth, elev);
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
        vec2 uv = fract(gl_FragCoord.xy / 32.0);
        float noise = texture2DLod(blueNoiseTex32, uv, 0.0).y;
        return alpha > noise;
    }

    bool strips(vec3 lp, vec3 worldRadii) {
        vec2 ae = calcAzimuthElev(normalize(lp));

        // Convert the angular coordinates to approximate world-space arc
        // lengths. Keeping the grid interval fixed in world space means that
        // scaling the ellipsoid exposes more grid lines instead of stretching
        // the original fixed-count grid.
        float azimuthRadius = max((worldRadii.x + worldRadii.z) * 0.5, 0.0001);
        float elevationRadius = max((azimuthRadius + worldRadii.y) * 0.5, 0.0001);
        vec2 arc = vec2(ae.x * azimuthRadius, ae.y * elevationRadius);

        float gridSize = 1.0;
        float lineHalfWidth = 0.015;
        vec2 distanceToLine = abs(fract(arc / gridSize + 0.5) - 0.5) * gridSize;
        return distanceToLine.x < lineHalfWidth || distanceToLine.y < lineHalfWidth;
    }

    void main() {
        vec2 clip = gl_FragCoord.xy / targetSize;
        vec3 worldNear = near_origin + near_x * clip.x + near_y * clip.y;
        vec3 worldFar = far_origin + far_x * clip.x + far_y * clip.y;

        // Transform ray into local space for ellipsoid intersection
        vec3 localNear = (matrix_model_inv * vec4(worldNear, 1.0)).xyz;
        vec3 localFar = (matrix_model_inv * vec4(worldFar, 1.0)).xyz;
        vec3 localDir = normalize(localFar - localNear);

        // The source sphere has radius 0.5. Matrix column lengths give its
        // world-space axis scales, including parent transforms.
        vec3 worldRadii = vec3(
            length(matrix_model[0].xyz),
            length(matrix_model[1].xyz),
            length(matrix_model[2].xyz)
        ) * 0.5;

        float t0, t1;
        if (!intersectSphereLocal(t0, t1, localNear, localDir)) {
            discard;
        }

        vec3 localFront = localNear + localDir * t0;
        bool front = t0 > 0.0 && strips(localFront, worldRadii);

        vec3 localBack = localNear + localDir * t1;
        bool back = strips(localBack, worldRadii);

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
