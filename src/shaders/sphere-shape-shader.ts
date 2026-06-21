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
        return vec2(azimuth, elev) * 180.0 / 3.14159;
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

    bool strips(vec3 lp) {
        vec2 ae = calcAzimuthElev(normalize(lp));

        float spacing = 180.0 / (2.0 * 3.14159 * 0.5);
        float size = 0.03;
        return fract(ae.x / spacing) < size ||
               fract(ae.y / spacing) < size;
    }

    void main() {
        vec2 clip = gl_FragCoord.xy / targetSize;
        vec3 worldNear = near_origin + near_x * clip.x + near_y * clip.y;
        vec3 worldFar = far_origin + far_x * clip.x + far_y * clip.y;

        // Transform ray into local space for ellipsoid intersection
        vec3 localNear = (matrix_model_inv * vec4(worldNear, 1.0)).xyz;
        vec3 localFar = (matrix_model_inv * vec4(worldFar, 1.0)).xyz;
        vec3 localDir = normalize(localFar - localNear);

        float t0, t1;
        if (!intersectSphereLocal(t0, t1, localNear, localDir)) {
            discard;
        }

        vec3 localFront = localNear + localDir * t0;
        bool front = t0 > 0.0 && strips(localFront);

        vec3 localBack = localNear + localDir * t1;
        bool back = strips(localBack);

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
