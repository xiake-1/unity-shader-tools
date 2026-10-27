Shader "G"
{
    SubShader
    {
        UsePass "Legacy Shaders/Diffuse"
        GrabPass { }
        Pass { }
    }
    Fallback Off
}
